'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log4js = require('log4js');
const { MongoClient } = require('mongodb');
const { PMTile, TILE_TYPE, COMPRESSION } = require('../lib/pmtile');
const { ZxyToID } = require('../lib/tileId');
const { AsyncPool } = require('../lib/asyncPool');
const { OrderedWriter } = require('../lib/orderedWriter');
const { MongoScanner } = require('../lib/mongoScanner');

log4js.configure(path.join(__dirname, '../config/log4js.config.json'));
const logger = log4js.getLogger('pmtiles');

const MAX_ZOOM = 20;

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

  MongoScanner.validateZoomRange(minZoom, maxZoom);

  logger.info(`Starting export from MongoDB: ${mongoUri}/${dbName}.${collectionName}`);
  logger.info(`Dataset: ${datasetName || '(all)'}`);
  logger.info(`Zoom range: [${minZoom !== undefined ? minZoom : 0}, ${maxZoom !== undefined ? maxZoom : MAX_ZOOM}]`);
  logger.info(`Output: ${outputPath}`);
  logger.info(`Concurrency: ${concurrency}`);

  const baseQuery = MongoScanner.buildQuery({ datasetName, minZoom, maxZoom });

  let client;
  let tempTileHandle;
  let tempTilePath;

  try {
    client = await MongoClient.connect(mongoUri);
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // ===== Stage 1: count + scan xyz =====
    const count = await collection.countDocuments(baseQuery);
    logger.info(`Found ${count} tile documents matching query`);
    if (count === 0) {
      logger.warn('No tiles found for the specified query');
      return;
    }

    logger.info('Stage 1: scanning tile xyz coordinates...');
    const xyzList = await MongoScanner.scanXyz(collection, baseQuery, batchSize);
    logger.info(`Stage 1 done: collected ${xyzList.length} xyz entries`);

    if (xyzList.length === 0) {
      logger.warn('No valid xyz entries after scan; aborting');
      return;
    }

    // Sort by Hilbert TileID + dedup
    logger.info('Sorting by Hilbert TileID...');
    const sorted = xyzList
      .map((v) => ({ ...v, tileId: BigInt(ZxyToID(v.z, v.x, v.y)) }))
      .sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));

    const dedupSorted = [];
    for (const item of sorted) {
      const last = dedupSorted[dedupSorted.length - 1];
      if (last && last.z === item.z && last.x === item.x && last.y === item.y) continue;
      dedupSorted.push(item);
    }
    logger.info(`Unique xyz count: ${dedupSorted.length}`);

    // ===== Stage 2: fetch + merge + dedup + ordered write =====
    logger.info('Stage 2: fetching and merging tile shards...');
    const resolvedTempDir = tempDir || path.dirname(outputPath);
    tempTilePath = path.join(resolvedTempDir, `pmtiles_tiledata_${Date.now()}.tmp`);
    tempTileHandle = await fs.promises.open(tempTilePath, 'w');

    const md5Index = new Map(); // md5hex -> { offset, length }
    const writer = new OrderedWriter(tempTileHandle);
    let fetchProgress = 0;

    const poolResults = await AsyncPool.run(dedupSorted, concurrency, async (item, idx) => {
      const merged = await MongoScanner.fetchTile(collection, baseQuery, item.z, item.x, item.y);
      if (!merged) {
        logger.warn(`No tile_data for z=${item.z} x=${item.x} y=${item.y}, skipping`);
        await writer.write(idx, null);
        return null;
      }

      fetchProgress++;
      if (fetchProgress % 5000 === 0) {
        logger.info(`Stage 2 progress: ${fetchProgress}/${dedupSorted.length} tiles, unique=${md5Index.size}`);
      }

      const md5 = crypto.createHash('md5').update(merged).digest('hex');
      const cached = md5Index.get(md5);
      if (cached) {
        await writer.write(idx, null);
        return {
          tileId: item.tileId,
          offset: cached.offset,
          length: cached.length,
          runLength: BigInt(1)
        };
      }

      const offset = await writer.write(idx, merged);
      const length = BigInt(merged.length);
      md5Index.set(md5, { offset, length });

      return { tileId: item.tileId, offset, length, runLength: BigInt(1) };
    });

    const entries = [];
    for (const r of poolResults) {
      if (r) entries.push(r);
    }

    await tempTileHandle.close();
    tempTileHandle = null;
    logger.info(`Stage 2 done: ${entries.length} entries, ${md5Index.size} unique tile contents, temp file size=${writer.bytesWritten}`);

    if (entries.length === 0) {
      logger.warn('No tile data fetched; aborting');
      return;
    }

    // ===== Stage 3: write PMTiles =====
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

module.exports = { exportFromMongo };
