const fs = require('fs');
const path = require('path');
const log4js = require('log4js');
const { PMTile, TILE_TYPE, COMPRESSION } = require('../lib/pmtile');
const { ZxyToID } = require('../lib/tileId');

log4js.configure(path.join(__dirname, '../config/log4js.config.json'));
const logger = log4js.getLogger('pmtiles');

const MAX_ZOOM = 20;
const MAX_LAT = 85.05112878; // Web Mercator 纬度上限
const EARTH_R = 6378137;     // Web Mercator 半径（米）

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function formatDuration(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/**
 * 轻量内联进度条（仅在 TTY 环境用 \r 原地刷新；非 TTY 不输出）。
 * 显示：[bar] pct% cur/total speed t/s skip:N size ETA
 */
class ProgressBar {
  constructor(total, options = {}) {
    this.total = total;
    this.current = 0;
    this.width = options.width || 30;
    this.isTTY =
      (process.stdout.isTTY && process.env.TERM !== 'dumb') ||
      process.env.PMTILES_FORCE_TTY === '1';
    this.startTime = Date.now();
    this.lastRender = 0;
    this.minInterval = options.minInterval != null ? options.minInterval : 100; // ms 节流，0=不节流
    this.extra = {};
    if (this.isTTY) this.render();
  }

  update(current, extra = {}) {
    this.current = current;
    this.extra = extra;
    if (!this.isTTY) return;
    const now = Date.now();
    if (now - this.lastRender < this.minInterval && current < this.total) return;
    this.render();
  }

  render() {
    const pct = this.total > 0 ? this.current / this.total : 0;
    const filled = Math.round(this.width * pct);
    const bar = '#'.repeat(filled).padEnd(this.width, '-');
    const pctStr = (pct * 100).toFixed(1).padStart(5, ' ') + '%';
    const cur = String(this.current).padStart(String(this.total).length, ' ');
    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = elapsed > 0 ? (this.current / elapsed).toFixed(1) : '0.0';
    const remaining = pct > 0 && this.current > 0 ? (elapsed * (this.total - this.current)) / this.current : 0;
    const etaStr = this.current >= this.total ? 'done' : formatDuration(remaining);

    const parts = [];
    if (this.extra.skipped !== undefined) parts.push(`skip:${this.extra.skipped}`);
    if (this.extra.size !== undefined) parts.push(formatBytes(this.extra.size));
    const extraStr = parts.length ? ' ' + parts.join(' ') : '';

    process.stdout.write(
      `\r[${bar}] ${pctStr} ${cur}/${this.total} ${speed}t/s${extraStr} ETA:${etaStr}`.padEnd(80, ' ')
    );
    this.lastRender = Date.now();
  }

  complete() {
    if (!this.isTTY) return;
    this.current = this.total;
    this.render();
    process.stdout.write('\n');
  }
}

/**
 * 校验 minZoom / maxZoom 参数合法性。
 */
function validateZoomRange(minZoom, maxZoom) {
  if (minZoom === undefined || maxZoom === undefined) {
    throw new Error('--min-zoom and --max-zoom are required');
  }
  if (minZoom < 0 || minZoom > MAX_ZOOM) {
    throw new Error(`--min-zoom must be in [0, ${MAX_ZOOM}], got ${minZoom}`);
  }
  if (maxZoom < 0 || maxZoom > MAX_ZOOM) {
    throw new Error(`--max-zoom must be in [0, ${MAX_ZOOM}], got ${maxZoom}`);
  }
  if (minZoom > maxZoom) {
    throw new Error(`--min-zoom (${minZoom}) must be <= --max-zoom (${maxZoom})`);
  }
}

/**
 * 构造瓦片请求 URL。
 * 支持两种写法：
 *   1) 占位符：URL 含 {x}/{y}/{z}/{l}（{l} 等价 {z}），直接替换。
 *   2) 自动检测：URL 含 x=/y=/l=/z= 查询参数，替换其值（覆盖示例 URL 形态）。
 */
function buildTileUrl(urlTemplate, { x, y, z }) {
  if (/\{[xyzl]\}/.test(urlTemplate)) {
    return urlTemplate
      .replace(/\{x\}/g, x)
      .replace(/\{y\}/g, y)
      .replace(/\{z\}/g, z)
      .replace(/\{l\}/g, z);
  }
  let url = urlTemplate.replace(/([?&]x=)[^&]*/i, `$1${x}`);
  url = url.replace(/([?&]y=)[^&]*/i, `$1${y}`);
  if (/[?&]l=/i.test(url)) {
    url = url.replace(/([?&]l=)[^&]*/i, `$1${z}`);
  }
  if (/[?&]z=/i.test(url)) {
    url = url.replace(/([?&]z=)[^&]*/i, `$1${z}`);
  }
  return url;
}

function lon2tileX(lon, z) {
  const n = Math.pow(2, z);
  return Math.floor(((lon + 180) / 360) * n);
}

function lat2tileY(lat, z) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const latRad = (clamped * Math.PI) / 180;
  const n = Math.pow(2, z);
  return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
}

/**
 * Web Mercator (EPSG:3857) 米坐标 → WGS84 经纬度。
 */
function webMercatorToLonLat(x, y) {
  const lon = ((x / EARTH_R) * 180) / Math.PI;
  const lat = ((2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) * 180) / Math.PI;
  return { lon, lat };
}

/**
 * 根据 bbox / srid / zoom 范围，生成所有瓦片并按 Hilbert TileID 升序排序。
 * bbox 为 [v0,v1,v2,v3]：
 *   srid 4326 → [minLon,minLat,maxLon,maxLat]（度）
 *   srid 3857 → [minX,minY,maxX,maxY]（米）
 */
function bboxToTiles(bbox, srid, minZoom, maxZoom) {
  let minLon, minLat, maxLon, maxLat;
  if (srid === 3857) {
    const ll = webMercatorToLonLat(bbox[0], bbox[1]);
    const ur = webMercatorToLonLat(bbox[2], bbox[3]);
    minLon = ll.lon; minLat = ll.lat;
    maxLon = ur.lon; maxLat = ur.lat;
  } else {
    minLon = bbox[0]; minLat = bbox[1];
    maxLon = bbox[2]; maxLat = bbox[3];
  }

  if (minLon > maxLon) {
    throw new Error(
      `Invalid bbox: minLon (${minLon}) > maxLon (${maxLon}); antimeridian-crossing bboxes are not supported`
    );
  }
  minLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, minLat));
  maxLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, maxLat));

  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const maxIndex = Math.pow(2, z) - 1;
    let minX = lon2tileX(minLon, z);
    let maxX = lon2tileX(maxLon, z);
    let minY = lat2tileY(maxLat, z); // 北 → 较小 y
    let maxY = lat2tileY(minLat, z); // 南 → 较大 y
    minX = Math.max(0, Math.min(maxIndex, minX));
    maxX = Math.max(0, Math.min(maxIndex, maxX));
    minY = Math.max(0, Math.min(maxIndex, minY));
    maxY = Math.max(0, Math.min(maxIndex, maxY));
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tiles.push({ z, x, y, tileId: BigInt(ZxyToID(z, x, y)) });
      }
    }
  }

  tiles.sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
  return tiles;
}

/**
 * 抓取单个瓦片。
 * 返回 Buffer（2xx 且非空）；返回 null（404 / 空响应，跳过不重试）；
 * 抛错（其它 4xx 立即抛；5xx/网络/超时按 retry 重试后仍失败抛错）。
 */
async function fetchTileBuffer(url, { timeoutMs, retry }) {
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err; // 网络/超时/abort → 可重试
      if (attempt < retry) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 30000));
        continue;
      }
      throw err;
    }

    if (res.status === 404) {
      clearTimeout(timer);
      return null;
    }
    if (res.status >= 400 && res.status < 500) {
      clearTimeout(timer);
      const err = new Error(`HTTP ${res.status}`);
      err.retriable = false;
      throw err;
    }
    if (res.status >= 500) {
      clearTimeout(timer);
      lastErr = new Error(`HTTP ${res.status} server error`);
      if (attempt < retry) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 30000));
        continue;
      }
      throw lastErr;
    }

    try {
      const ab = await res.arrayBuffer();
      clearTimeout(timer);
      if (ab.byteLength === 0) return null;
      return Buffer.from(ab);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retry) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 30000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('fetch failed');
}

/**
 * 抓取单个瓦片（带 tile 上下文）。任何失败记 warn 并返回 buf:null，确保不 reject。
 */
async function fetchOne(tile, urlTemplate, opts) {
  const url = buildTileUrl(urlTemplate, { x: tile.x, y: tile.y, z: tile.z });
  try {
    const buf = await fetchTileBuffer(url, opts);
    return { tile, buf };
  } catch (err) {
    logger.warn(
      `z=${tile.z} x=${tile.x} y=${tile.y} failed after ${opts.retry} retries: ${err.message}; skipping`
    );
    return { tile, buf: null };
  }
}

async function exportFromUrl(options) {
  const {
    urlTemplate,
    outputPath,
    minZoom,
    maxZoom,
    bbox,
    srid = 4326,
    tileType = TILE_TYPE.PNG,
    tileCompression = COMPRESSION.NO_COMPRESSION,
    concurrency = 20,
    retry = 3,
    timeoutMs = 30000,
    tempDir,
    name = 'Raster Tiles',
    description
  } = options;

  validateZoomRange(minZoom, maxZoom);
  if (!urlTemplate) throw new Error('--url is required');
  if (!outputPath) throw new Error('--output is required');
  if (!bbox) throw new Error('--bbox is required');
  if (srid !== 4326 && srid !== 3857) {
    throw new Error(`--srid must be 4326 or 3857, got ${srid}`);
  }

  logger.info(`Exporting raster tiles from URL: ${urlTemplate}`);
  logger.info(`Zoom range: [${minZoom}, ${maxZoom}], bbox: ${bbox.join(',')}, srid: ${srid}`);
  logger.info(
    `Tile type: ${tileType === TILE_TYPE.PNG ? 'png' : 'jpg'}, ` +
      `compression: ${tileCompression === COMPRESSION.GZIP ? 'gzip' : 'none'}`
  );
  logger.info(`Concurrency: ${concurrency}, retry: ${retry}, timeout: ${timeoutMs}ms`);
  logger.info(`Output: ${outputPath}`);

  const tiles = bboxToTiles(bbox, srid, minZoom, maxZoom);
  logger.info(`Total tiles to fetch: ${tiles.length}`);
  if (tiles.length === 0) {
    logger.warn('No tiles in the given bbox/zoom range; aborting');
    return;
  }

  const resolvedTempDir = tempDir || path.dirname(outputPath);
  const tempTilePath = path.join(resolvedTempDir, `pmtiles_tiledata_${Date.now()}.tmp`);
  let tempHandle = null;
  const entries = [];
  let pos = 0;
  let processed = 0;
  let skipped = 0;
  let lastLogged = 0;

  // TTY 用内联进度条；非 TTY（重定向/CI）回退到 log4js 周期日志，二者皆实时反映进度。
  const bar = new ProgressBar(tiles.length);

  try {
    tempHandle = await fs.promises.open(tempTilePath, 'w');
    const fetchOpts = { timeoutMs, retry };

    // 分批并发抓取；批内按 tileId 顺序（=输入顺序）顺序写入临时文件，
    // 保证临时文件瓦片数据按 tileId 升序排列 → clustered=true 真实成立。
    for (let i = 0; i < tiles.length; i += concurrency) {
      const batch = tiles.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((t) => fetchOne(t, urlTemplate, fetchOpts))
      );

      for (const { tile, buf } of results) {
        processed++;
        if (!buf || buf.length === 0) {
          skipped++;
        } else {
          await tempHandle.write(buf);
          entries.push({
            tileId: tile.tileId,
            offset: BigInt(pos),
            length: BigInt(buf.length),
            runLength: BigInt(1)
          });
          pos += buf.length;
        }
        bar.update(processed, { skipped, size: pos });
        // 非 TTY 周期日志（TTY 由进度条实时刷新）
        if (!bar.isTTY && (processed - lastLogged >= 5000 || processed === tiles.length)) {
          logger.info(
            `Progress: ${processed}/${tiles.length} processed, skipped=${skipped}, ` +
              `written=${entries.length}, tempSize=${pos}`
          );
          lastLogged = processed;
        }
      }
    }

    bar.complete();
    await tempHandle.close();
    tempHandle = null;
    logger.info(
      `Fetch done: ${entries.length} tiles written, ${skipped} skipped, tempSize=${pos}`
    );

    if (entries.length === 0) {
      logger.warn('No tile data fetched; aborting');
      return;
    }

    logger.info('Writing PMTiles file...');
    const pmtile = new PMTile();
    pmtile.setTileType(tileType);
    pmtile.setTileCompression(tileCompression);
    pmtile.setMetadata({
      name,
      description: description || `Raster tiles exported from ${urlTemplate}`,
      tileType: 'raster',
      format: tileType === TILE_TYPE.PNG ? 'png' : 'jpg',
      minZoom,
      maxZoom,
      bbox: bbox.join(','),
      srid
    });

    await pmtile.writeStreaming(outputPath, entries, tempTilePath, { tempDir: resolvedTempDir });
    logger.info(`Successfully exported ${entries.length} tiles to ${outputPath}`);
  } catch (err) {
    logger.error('Export failed:', err);
    throw err;
  } finally {
    if (tempHandle) {
      try { await tempHandle.close(); } catch (_) {}
    }
    await fs.promises.unlink(tempTilePath).catch(() => {});
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url': options.urlTemplate = args[++i]; break;
      case '--output': options.outputPath = args[++i]; break;
      case '--min-zoom': options.minZoom = parseInt(args[++i], 10); break;
      case '--max-zoom': options.maxZoom = parseInt(args[++i], 10); break;
      case '--bbox': {
        const raw = args[++i];
        const parts = raw.split(',').map((s) => parseFloat(s.trim()));
        if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) {
          console.error(`Invalid --bbox: ${raw}; expected minLon,minLat,maxLon,maxLat`);
          process.exit(1);
        }
        options.bbox = parts;
        break;
      }
      case '--srid': options.srid = parseInt(args[++i], 10); break;
      case '--tile-type': {
        const t = args[++i].toLowerCase();
        if (t === 'png') options.tileType = TILE_TYPE.PNG;
        else if (t === 'jpg' || t === 'jpeg') options.tileType = TILE_TYPE.JPEG;
        else console.error(`Unknown --tile-type: ${t} (png|jpg|jpeg)`);
        break;
      }
      case '--compression': {
        const c = args[++i].toLowerCase();
        if (c === 'none') options.tileCompression = COMPRESSION.NO_COMPRESSION;
        else if (c === 'gzip') options.tileCompression = COMPRESSION.GZIP;
        else console.error(`Unknown --compression: ${c} (none|gzip)`);
        break;
      }
      case '--concurrency': options.concurrency = parseInt(args[++i], 10); break;
      case '--retry': options.retry = parseInt(args[++i], 10); break;
      case '--timeout': options.timeoutMs = parseInt(args[++i], 10); break;
      case '--temp-dir': options.tempDir = args[++i]; break;
      case '--name': options.name = args[++i]; break;
      case '--description': options.description = args[++i]; break;
      case '-h':
      case '--help': options._help = true; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        break;
    }
  }
  return options;
}

function printUsage() {
  console.error('Usage: node exportFromUrl.js --url <url> --output <path> --min-zoom <n> --max-zoom <n> --bbox <minLon,minLat,maxLon,maxLat> [options]');
  console.error('Options:');
  console.error('  --url <url>          Tile source URL template. Supports {x}/{y}/{z}/{l} placeholders,');
  console.error('                       or auto-replaces x=/y=/l=/z= query params.');
  console.error('  --output <path>      Output .pmtiles path');
  console.error('  --min-zoom <num>     Min zoom level (inclusive, 0-26)');
  console.error('  --max-zoom <num>     Max zoom level (inclusive, 0-26)');
  console.error('  --bbox <minLon,minLat,maxLon,maxLat>');
  console.error('                       Bounding box (4326: degrees; 3857: meters as minX,minY,maxX,maxY)');
  console.error('  --srid <num>         Coordinate system: 4326 (default) or 3857');
  console.error('  --tile-type <type>   png (default) | jpg | jpeg');
  console.error('  --compression <type> none (default) | gzip');
  console.error('  --concurrency <num>  Concurrent requests / batch size (default: 20)');
  console.error('  --retry <num>        Retries on transient errors (default: 3)');
  console.error('  --timeout <ms>       Request timeout in ms (default: 30000)');
  console.error('  --temp-dir <path>    Temp directory (default: same as output)');
  console.error('  --name <text>        Metadata name (default: Raster Tiles)');
  console.error('  --description <text> Metadata description');
}

async function main() {
  const options = parseArgs(process.argv);
  if (options._help || !options.outputPath) {
    printUsage();
    process.exit(options._help ? 0 : 1);
  }
  await exportFromUrl(options);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = {
  exportFromUrl,
  buildTileUrl,
  bboxToTiles,
  fetchTileBuffer,
  validateZoomRange,
  lon2tileX,
  lat2tileY,
  webMercatorToLonLat,
  ProgressBar
};
