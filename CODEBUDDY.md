# CODEBUDDY.md — pmtiles-core 项目指南

本项目是基于 Node.js 的 **PMTiles v3 读写系统**，支持从 MongoDB 导出瓦片数据、或从瓦片服务 URL 并发抓取栅格瓦片（PNG/JPG）导出为 PMTiles 单文件格式。

## 常用命令

```bash
# 安装依赖
npm install

# 运行测试（pmtile 主测试）
npm test

# Header 调试脚本
node test/debug_header.js

# uint64 调试脚本
node test/debug_uint64.js

# 从 MongoDB 导出 PMTiles
npm run export -- --output tiles.pmtiles --dataset my_dataset --mongo-uri mongodb://localhost:27017

# 从瓦片服务 URL 导出栅格 PMTiles（PNG/JPG）
npm run export-url -- \
  --url "http://host/mapserver/vmap/bj68w/getMap?styleId=bj68w&x={x}&y={y}&l={z}" \
  --output tiles.pmtiles --min-zoom 8 --max-zoom 14 \
  --bbox 115.8,39.4,117.4,41.1 --srid 4326 --tile-type png --concurrency 20
```

## 架构概览

```
lib/
├── pmtile.js           # PMTile 核心类：文件读写、瓦片增删、目录构建
├── header.js           # HeaderV3 序列化/反序列化、Metadata 压缩；导出 COMPRESSION、TILE_TYPE 常量
├── directory.js        # Entry 序列化（delta 编码 + varint）、反序列化、二分查找 findTile
├── leafDictionary.js   # 自动 Leaf Dictionary 切分；目标根目录大小 16384-127=16257 字节
├── tileId.js           # Hilbert 曲线 TileID 编码：ZxyToID / IDToZxy
├── utils.js            # 字节序读写（小端序）、varint 编解码、字符串读写
scripts/exportFromMongo.js  # MongoDB → PMTiles 导出脚本（支持命令行参数）
scripts/exportFromUrl.js    # 瓦片服务 URL → 栅格 PMTiles 导出脚本（并发抓取 PNG/JPG，含进度条）
config/log4js.config.json   # log4js 配置（控制台 + 文件输出，日志在 logs/pmtiles.log）
test/                       # 测试与调试脚本
```

## 核心约定

### 数据类型与精度（关键）
- PMTiles v3 的 64 位字段（tileId、offset、length、runLength 及 Header 中的 uint64 字段）统一使用 **BigInt** 表示。
- `utils.js` 中 `putUint64LE` 使用 `writeBigUInt64LE` 正确处理大数；**注意 `getUint64LE` 返回 `Number()`，对超过 2^53 的值会丢失精度**——处理超大文件偏移时需特别留意。
- `header.js` 中 `deserializeHeader` 依赖 `getUint64LE`，因此 Header 字段同样存在上述精度隐患。

### PMTiles v3 文件布局
文件按以下顺序连续排列：
1. **Header**（127 字节，magic=`PMTiles`，specVersion=3）
2. **Root Directory**（条目或叶子目录指针）
3. **Metadata**（JSON，按 internalCompression 压缩）
4. **Leaf Directories**（仅当瓦片条目数 ≥ 16384 或根目录超 16257 字节时生成）
5. **Tile Data**（按 TileID 升序聚类存储）

### Leaf Dictionary 自动切分
- 位于 `leafDictionary.js` 的 `buildDirectories`：先尝试将全部条目作为根目录；超限时按 `leafSize = max(4096, 条目数/3500)` 切分，并以 `×1.2` 迭代放大直到根目录 ≤ 16257 字节。
- `runLength === 0` 的根条目表示指向叶子目录的指针（`offset`/`length` 为叶子在叶子区的相对偏移与长度）。

### Directory 序列化（directory.js）
- 条目数 → 各 tileId 的 delta → 各 runLength → 各 length → 各 offset，五段分别连续 varint 编码后整体 GZIP 压缩。
- offset delta：相邻连续条目记 0，否则记 `offset+1`（解码时减 1）。

### TileID（tileId.js）
- 基于 Hilbert 曲线，`ZxyToID(z,x,y)` 与 `IDToZxy(tileId)` 互逆；z 上限 26（安全整数限制）。

### 压缩与瓦片类型常量（header.js）
- `COMPRESSION`: UNKNOWN=0 / NO_COMPRESSION=1 / GZIP=2 / BROTLI=3 / ZSTD=4（当前仅实现 NO_COMPRESSION 与 GZIP）
- `TILE_TYPE`: UNKNOWN=0 / MVT=1 / PNG=2 / JPEG=3 / WEBP=4 / AVIF=5 / MLT=6
- 默认 internalCompression=GZIP，tileCompression=GZIP，tileType=MVT。

### PMTile 类用法要点（lib/pmtile.js）
- 读取：`PMTile.open(path)` → `readMetadata()` / `readRootDirectory()` / `readTile(z,x,y)` → `close()`。
- 写入：`new PMTile()` → `setTileType` / `setTileCompression` / `setMetadata` → `addTile` 或 `addTiles` → `write(outputPath)`。
- `write` 通过临时文件 + `rename` 原子落盘；`_updateBounds` 会根据条目重算 minZoom/maxZoom/边界/中心点。

### 日志
- 全局使用 log4js，logger 名 `pmtiles`，配置见 `config/log4js.config.json`（控制台 + 文件，pmtiles category 级别 debug）。

### MongoDB 导出（scripts/exportFromMongo.js）
- 集合文档需含 `zoom`、`x`、`y`、`tile_data`（Buffer），可选 `dataset` 用于筛选。
- 支持命令行参数：`--output`(必填) `--mongo-uri` `--db` `--collection` `--dataset` `--batch-size` `--tile-type` `--compression`。

### 栅格瓦片 URL 导出（scripts/exportFromUrl.js）
- 给定瓦片源 URL 模板 + zoom 范围 + bbox + srid，并发抓取 PNG/JPG 栅格瓦片，按 Hilbert TileID 有序写入 PMTiles。
- **URL 模板**：支持 `{x}`/`{y}`/`{z}`/`{l}` 占位符（`{l}` 等价 `{z}`）；或不带占位符时自动替换 `x=`/`y=`/`l=`/`z=` 查询参数值（其余参数如 `styleId` 保留）。
- **坐标系**：Y 轴按 XYZ（y 从上往下，不翻转）；`--srid` 支持 4326（度）或 3857（Web Mercator 米，自动转经纬度）；纬度钳制 ±85.05112878，瓦片范围钳制 `[0,2^z-1]`；不支持穿越反子午线的 bbox。
- **缺失瓦片处理**：404 / 空响应静默跳过；5xx / 网络 / 超时按 `--retry` 指数退避重试后仍失败则跳过并告警；其它 4xx 立即跳过告警。
- **有序写入**：先按 tileId 升序排序，再分批（批大小=并发数）并发抓取、批内按 tileId 顺序写入临时文件，保证 `clustered=true` 真实成立（不做 MD5 去重，避免 offset 非单调破坏 clustered 语义）。
- **栅格默认 `tileCompression=NO_COMPRESSION`**（PNG/JPG 已压缩，区别于 MongoDB 导出默认 GZIP）。
- **进度条**：TTY 环境用 `\r` 原地刷新（百分比/速率/跳过数/大小/ETA，100ms 节流）；非 TTY（重定向/CI）回退到 log4js 每 5000 个的周期日志；设 `PMTILES_FORCE_TTY=1` 可强制启用。
- 支持命令行参数：`--url`(必填) `--output`(必填) `--min-zoom`/`--max-zoom`(必填) `--bbox`(必填, `minLon,minLat,maxLon,maxLat`) `--srid`(默认 4326) `--tile-type`(默认 png, png|jpg|jpeg) `--compression`(默认 none, none|gzip) `--concurrency`(默认 20) `--retry`(默认 3) `--timeout`(默认 30000ms) `--temp-dir` `--name` `--description`。

## 依赖
- `pmtiles@^4.4.1`（参考规范与部分结构）
- `log4js@^6.9.1`（日志）
- `mongodb@^6.3.0`（MongoDB 驱动）
- `@mapbox/vector-tile@^2.0.2` + `@mapbox/pbf@^4.0.0`（MVT 编解码，替代旧 `lib/mvt.js`）

## 注意事项
- 处理大文件偏移/超大 TileID 时，优先保持 BigInt 链路完整，避免中途转 Number。
- 新增压缩类型（BROTLI/ZSTD）需在 `header.js` 与 `directory.js` 同步实现编解码分支。
- 修改序列化逻辑后，务必跑通 `test/pmtile.test.js`（含 TileID、Header、写读往返测试）。
- 临时输出文件 `test_output.pmtiles` 已在 `.gitignore` 中忽略。
