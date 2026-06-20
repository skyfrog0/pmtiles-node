const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log4js = require('log4js');
const { MongoClient } = require('mongodb');
const { PMTile, TILE_TYPE, COMPRESSION } = require('../lib/pmtile');
const { ZxyToID } = require('../lib/tileId');

log4js.configure(path.join(__dirname, '../config/log4js.config.json'));
const logger = log4js.getLogger('pmtiles');

const MAX_ZOOM = 20;

/**
 * 构造查询条件：dataset / zoom 范围过滤。
 * 三个阶段（count / xyz 扫描 / 瓦片拉取）共用同一基础 query。
 */
function buildQuery({ datasetName, minZoom, maxZoom }) {
  const query = {};
  if (datasetName) {
    query.dataset = datasetName;
  }
  if (minZoom !== undefined || maxZoom !== undefined) {
    const zoomCond = {};
    if (minZoom !== undefined) zoomCond.$gte = minZoom;
    if (maxZoom !== undefined) zoomCond.$lte = maxZoom;
    query.zoom = zoomCond;
  }
  return query;
}

/**
 * 校验 minZoom / maxZoom 参数合法性。
 */
function validateZoomRange(minZoom, maxZoom) {
  if (minZoom !== undefined && (minZoom < 0 || minZoom > MAX_ZOOM)) {
    throw new Error(`--min-zoom must be in [0, ${MAX_ZOOM}], got ${minZoom}`);
  }
  if (maxZoom !== undefined && (maxZoom < 0 || maxZoom > MAX_ZOOM)) {
    throw new Error(`--max-zoom must be in [0, ${MAX_ZOOM}], got ${maxZoom}`);
  }
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    throw new Error(`--min-zoom (${minZoom}) must be <= --max-zoom (${maxZoom})`);
  }
}

/**
 * 简易并发池：限制 worker 并发数为 size，按 items 顺序返回结果。
 */
async function asyncPool(items, size, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function runOne() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
      completed++;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(size, items.length); i++) {
    workers.push(runOne());
  }
  await Promise.all(workers);
  return results;
}

/**
 * 拉取单个 xyz 对应的所有分片，按 _id 升序拼接为完整瓦片 Buffer。
 */
async function fetchAndMergeTile(collection, baseQuery, z, x, y) {
  const tileQuery = { ...baseQuery, zoom: z, x, y };
  // 删除 zoom 范围条件（已被精确值覆盖）
  if (tileQuery.zoom && typeof tileQuery.zoom === 'object') {
    delete tileQuery.zoom;
    tileQuery.zoom = z;
  }
  const docs = await collection.find(tileQuery).sort({ _id: 1 }).toArray();
  if (docs.length === 0) return null;

  const buffers = docs.map((doc) => {
    if (!doc.tile_data) return null;
    return doc.tile_data.buffer ? doc.tile_data : Buffer.from(doc.tile_data);
  }).filter((b) => b !== null);

  if (buffers.length === 0) return null;
  return Buffer.concat(buffers);
}

async function exportFromMongo(options) {
  const {
    mongoUri = 'mongodb://localhost:27017',
    dbName = 'tiles',
    collectionName = 'tiles',
    datasetName,
    outputPath,
    batchSize = 1000,
    tileType = TILE_TYPE.MVT,
    tileCompression = COMPRESSION.GZIP,
    minZoom,
    maxZoom,
    concurrency = 20,
    tempDir
  } = options;

  validateZoomRange(minZoom, maxZoom);

  logger.info(`Starting export from MongoDB: ${mongoUri}/${dbName}.${collectionName}`);
  logger.info(`Dataset: ${datasetName || '(all)'}`);
  logger.info(`Zoom range: [${minZoom !== undefined ? minZoom : 0}, ${maxZoom !== undefined ? maxZoom : MAX_ZOOM}]`);
  logger.info(`Output: ${outputPath}`);
  logger.info(`Concurrency: ${concurrency}`);

  const baseQuery = buildQuery({ datasetName, minZoom, maxZoom });

  let client;
  let tempTileHandle;
  let tempTilePath;

  try {
    client = await MongoClient.connect(mongoUri);
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // ===== 阶段一：统计 + 拉取 xyz 编号 =====
    const count = await collection.countDocuments(baseQuery);
    logger.info(`Found ${count} tile documents matching query`);
    if (count === 0) {
      logger.warn('No tiles found for the specified query');
      return;
    }

    logger.info('Stage 1: scanning tile xyz coordinates...');
    const xyzList = [];
    const cursor = collection
      .find(baseQuery, { projection: { _id: 0, zoom: 1, x: 1, y: 1 } })
      .batchSize(batchSize)
      .noCursorTimeout();

    try {
      await cursor.forEach((doc) => {
        if (doc.zoom === undefined || doc.x === undefined || doc.y === undefined) {
          logger.warn(`Skipping doc with missing xyz: ${JSON.stringify(doc)}`);
          return;
        }
        xyzList.push({ z: doc.zoom, x: doc.x, y: doc.y });
      });
    } finally {
      await cursor.close();
    }
    logger.info(`Stage 1 done: collected ${xyzList.length} xyz entries`);

    if (xyzList.length === 0) {
      logger.warn('No valid xyz entries after scan; aborting');
      return;
    }

    // ===== 排序：按 tileId 升序 =====
    logger.info('Sorting by Hilbert TileID...');
    const sorted = xyzList
      .map((v) => ({ ...v, tileId: BigInt(ZxyToID(v.z, v.x, v.y)) }))
      .sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));

    // 去重 xyz（相同 xyz 在阶段二会被合并为一份瓦片，故条目只保留一份）
    const dedupSorted = [];
    for (const item of sorted) {
      const last = dedupSorted[dedupSorted.length - 1];
      if (last && last.z === item.z && last.x === item.x && last.y === item.y) {
        continue;
      }
      dedupSorted.push(item);
    }
    logger.info(`Unique xyz count: ${dedupSorted.length}`);

    // ===== 阶段二：按 tileId 顺序拉取瓦片分片，拼接 + MD5 去重，写入临时瓦片文件 =====
    logger.info('Stage 2: fetching and merging tile shards...');
    const resolvedTempDir = tempDir || path.dirname(outputPath);
    tempTilePath = path.join(resolvedTempDir, `pmtiles_tiledata_${Date.now()}.tmp`);
    tempTileHandle = await fs.promises.open(tempTilePath, 'w');

    const md5Index = new Map(); // md5hex -> { offset, length }
    const entries = [];
    let tempTileSize = 0;
    let processed = 0;

    await asyncPool(dedupSorted, concurrency, async (item) => {
      const merged = await fetchAndMergeTile(collection, baseQuery, item.z, item.x, item.y);
      if (!merged) {
        logger.warn(`No tile_data for z=${item.z} x=${item.x} y=${item.y}, skipping`);
        return;
      }

      const md5 = crypto.createHash('md5').update(merged).digest('hex');

      let offset;
      let length;
      const cached = md5Index.get(md5);
      if (cached) {
        offset = cached.offset;
        length = cached.length;
      } else {
        offset = BigInt(tempTileSize);
        length = BigInt(merged.length);
        // 串行写文件（worker 间共享 fileHandle）
        await tempTileHandle.write(merged);
        tempTileSize += merged.length;
        md5Index.set(md5, { offset, length });
      }

      entries.push({
        tileId: item.tileId,
        offset,
        length,
        runLength: BigInt(1)
      });

      processed++;
      if (processed % 5000 === 0) {
        logger.info(`Stage 2 progress: ${processed}/${dedupSorted.length} tiles, unique=${md5Index.size}`);
      }
    });

    await tempTileHandle.close();
    tempTileHandle = null;
    logger.info(`Stage 2 done: ${entries.length} entries, ${md5Index.size} unique tile contents, temp file size=${tempTileSize}`);

    if (entries.length === 0) {
      logger.warn('No tile data fetched; aborting');
      return;
    }

    // ===== 阶段三：调用 writeStreaming 流式落盘 =====
    logger.info('Stage 3: writing PMTiles file...');
    const pmtile = new PMTile();
    pmtile.setTileType(tileType);
    pmtile.setTileCompression(tileCompression);
    pmtile.setMetadata({
      name: datasetName || 'Exported Tiles',
      description: `Exported from MongoDB collection ${collectionName}`,
      created: new Date().toISOString(),
      tileType: tileType === TILE_TYPE.MVT ? 'vector' : 'raster',
      compression: tileCompression === COMPRESSION.GZIP ? 'gzip' : 'none',
      minZoom: minZoom !== undefined ? minZoom : undefined,
      maxZoom: maxZoom !== undefined ? maxZoom : undefined
    });

    await pmtile.writeStreaming(outputPath, entries, tempTilePath, { tempDir: resolvedTempDir });
    logger.info(`Successfully exported ${entries.length} tiles (${md5Index.size} unique) to ${outputPath}`);
  } catch (err) {
    logger.error('Export failed:', err);
    throw err;
  } finally {
    if (tempTileHandle) {
      try { await tempTileHandle.close(); } catch (_) {}
    }
    if (tempTilePath) {
      await fs.promises.unlink(tempTilePath).catch(() => {});
    }
    if (client) {
      await client.close();
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mongo-uri': options.mongoUri = args[++i]; break;
      case '--db': options.dbName = args[++i]; break;
      case '--collection': options.collectionName = args[++i]; break;
      case '--dataset': options.datasetName = args[++i]; break;
      case '--output': options.outputPath = args[++i]; break;
      case '--batch-size': options.batchSize = parseInt(args[++i], 10); break;
      case '--tile-type': {
        const type = args[++i].toLowerCase();
        if (type === 'mvt') options.tileType = TILE_TYPE.MVT;
        else if (type === 'png') options.tileType = TILE_TYPE.PNG;
        else if (type === 'jpg') options.tileType = TILE_TYPE.JPEG;
        else if (type === 'webp') options.tileType = TILE_TYPE.WEBP;
        break;
      }
      case '--compression': {
        const comp = args[++i].toLowerCase();
        if (comp === 'gzip') options.tileCompression = COMPRESSION.GZIP;
        else if (comp === 'none') options.tileCompression = COMPRESSION.NO_COMPRESSION;
        break;
      }
      case '--min-zoom': options.minZoom = parseInt(args[++i], 10); break;
      case '--max-zoom': options.maxZoom = parseInt(args[++i], 10); break;
      case '--concurrency': options.concurrency = parseInt(args[++i], 10); break;
      case '--temp-dir': options.tempDir = args[++i]; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        break;
    }
  }
  return options;
}

function printUsage() {
  console.error('Usage: node exportFromMongo.js --output <path> [options]');
  console.error('Options:');
  console.error('  --mongo-uri <uri>      MongoDB connection URI (default: mongodb://localhost:27017)');
  console.error('  --db <name>            Database name (default: tiles)');
  console.error('  --collection <name>    Collection name (default: tiles)');
  console.error('  --dataset <name>       Dataset name filter');
  console.error('  --min-zoom <num>       Min zoom level (inclusive, 0-26)');
  console.error('  --max-zoom <num>       Max zoom level (inclusive, 0-26)');
  console.error('  --batch-size <num>     Batch size for reading (default: 1000)');
  console.error('  --concurrency <num>    Concurrency for tile fetching (default: 20)');
  console.error('  --temp-dir <path>      Temp directory (default: same as output)');
  console.error('  --tile-type <type>     Tile type: mvt, png, jpg, webp (default: mvt)');
  console.error('  --compression <type>   Compression: gzip, none (default: gzip)');
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.outputPath) {
    printUsage();
    process.exit(1);
  }
  await exportFromMongo(options);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = {
  exportFromMongo,
  buildQuery,
  validateZoomRange,
  asyncPool,
  fetchAndMergeTile
};
