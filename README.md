# PMTiles Core

基于 Node.js 的 PMTiles v3 读写系统，支持从 MongoDB 导出瓦片数据为 PMTiles 单文件格式。

## 特性

- 完整支持 PMTiles v3 规范
- 自动切分 Leaf Dictionaries，优化大文件随机访问性能
- 支持 Hilbert 曲线 TileID 编码
- 支持从 MongoDB 批量导出瓦片数据
- 使用 log4js 进行日志记录
- 支持大数据量处理（临时文件存储）

## 安装

```bash
npm install
```

## 项目结构

```
pmtiles-core/
├── lib/
│   ├── pmtile.js           # PMTiles 核心读写类
│   ├── header.js           # Header 处理模块
│   ├── directory.js        # Directory 处理模块
│   ├── leafDictionary.js   # Leaf Dictionary 处理模块
│   ├── tileId.js           # TileID 编码模块
│   └── utils.js            # 工具函数
├── scripts/
│   └── exportFromMongo.js  # MongoDB 导出脚本
├── config/
│   └── log4js.config.json  # log4js 配置
└── test/
    └── pmtile.test.js      # 测试用例
```

## 使用示例

### 读取 PMTiles 文件

```javascript
const { PMTile } = require('./lib/pmtile');

async function readExample() {
  const pmtile = await PMTile.open('example.pmtiles');
  
  // 读取元数据
  const metadata = await pmtile.readMetadata();
  console.log(metadata);
  
  // 读取单个瓦片
  const tile = await pmtile.readTile(5, 10, 15);
  if (tile) {
    console.log(`瓦片数据大小: ${tile.length} bytes`);
  }
  
  await pmtile.close();
}
```

### 创建 PMTiles 文件

```javascript
const { PMTile, TILE_TYPE, COMPRESSION } = require('./lib/pmtile');
const fs = require('fs');

async function createExample() {
  const pmtile = new PMTile();
  
  // 设置瓦片类型
  pmtile.setTileType(TILE_TYPE.MVT);
  pmtile.setTileCompression(COMPRESSION.GZIP);
  
  // 设置元数据
  pmtile.setMetadata({
    name: 'My Tiles',
    description: '示例瓦片数据'
  });
  
  // 添加瓦片
  for (let z = 0; z <= 5; z++) {
    const size = Math.pow(2, z);
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        const tileData = fs.readFileSync(`tiles/${z}/${x}/${y}.mvt`);
        pmtile.addTile(z, x, y, tileData);
      }
    }
  }
  
  // 写入文件
  await pmtile.write('output.pmtiles');
  console.log('PMTiles 文件创建成功');
}
```

### 从 MongoDB 导出

```bash
node scripts/exportFromMongo.js --output tiles.pmtiles --dataset my_dataset --mongo-uri mongodb://localhost:27017
```

#### 命令行参数

| 参数 | 描述 | 默认值 |
|------|------|--------|
| `--output <path>` | 输出文件路径 | 必需 |
| `--mongo-uri <uri>` | MongoDB 连接地址 | mongodb://localhost:27017 |
| `--db <name>` | 数据库名称 | tiles |
| `--collection <name>` | 集合名称 | tiles |
| `--dataset <name>` | 数据集名称过滤 | 全部 |
| `--batch-size <num>` | 批量处理大小 | 1000 |
| `--tile-type <type>` | 瓦片类型: mvt, png, jpg, webp | mvt |
| `--compression <type>` | 压缩类型: gzip, none | gzip |

#### MongoDB 数据结构要求

集合中的文档应包含以下字段：

```javascript
{
  zoom: Number,      // 缩放级别
  x: Number,         // X 坐标
  y: Number,         // Y 坐标
  tile_data: Buffer  // 瓦片二进制数据
}
```

可选字段：
```javascript
{
  dataset: String    // 数据集名称（用于筛选）
}
```

## API 文档

### PMTile 类

#### 静态方法

- `PMTile.open(filePath)` - 打开 PMTiles 文件
- `PMTile.open(filePath, options)` - 打开文件并指定选项

#### 实例方法

- `readHeader()` - 读取文件头
- `readMetadata()` - 读取元数据
- `readRootDirectory()` - 读取根目录
- `readLeafDirectory(offset, length)` - 读取叶子目录
- `readTile(z, x, y)` - 读取指定瓦片
- `close()` - 关闭文件
- `addTile(z, x, y, data)` - 添加单个瓦片
- `addTiles(tiles)` - 批量添加瓦片
- `write(outputPath, options)` - 写入 PMTiles 文件
- `setMetadata(metadata)` - 设置元数据
- `setTileType(tileType)` - 设置瓦片类型
- `setTileCompression(compression)` - 设置压缩类型

### 常量

#### 瓦片类型 (TILE_TYPE)

- `TILE_TYPE.UNKNOWN` - 未知
- `TILE_TYPE.MVT` - Mapbox Vector Tile
- `TILE_TYPE.PNG` - PNG 图像
- `TILE_TYPE.JPEG` - JPEG 图像
- `TILE_TYPE.WEBP` - WebP 图像
- `TILE_TYPE.AVIF` - AVIF 图像
- `TILE_TYPE.MLT` - MapLibre Tile

#### 压缩类型 (COMPRESSION)

- `COMPRESSION.UNKNOWN` - 未知
- `COMPRESSION.NO_COMPRESSION` - 无压缩
- `COMPRESSION.GZIP` - GZIP 压缩
- `COMPRESSION.BROTLI` - Brotli 压缩
- `COMPRESSION.ZSTD` - Zstandard 压缩

### TileID 工具

```javascript
const { ZxyToID, IDToZxy } = require('./lib/tileId');

// ZXY 转 TileID
const tileId = ZxyToID(5, 10, 15);

// TileID 转 ZXY
const { z, x, y } = IDToZxy(tileId);
```

## PMTiles v3 文件格式

PMTiles 文件由以下部分组成：

1. **Header** (127 字节) - 文件头，包含元数据偏移和大小
2. **Root Directory** - 根目录，索引入口
3. **Metadata** - JSON 元数据（可选压缩）
4. **Leaf Directories** - 叶子目录，用于优化大文件
5. **Tile Data** - 瓦片数据

### 自动 Leaf Dictionary 切分

当瓦片条目数超过 16384 时，系统会自动创建 Leaf Directories：

1. 计算初始 Leaf Size（条目数 / 3500，最小 4096）
2. 将条目切分为多个叶子目录
3. 根目录包含叶子目录的指针
4. 迭代调整直到根目录大小符合要求（≤16257 字节）

## 运行测试

```bash
npm test
```

## 日志配置

日志配置文件位于 `config/log4js.config.json`，支持控制台和文件输出：

```json
{
  "appenders": {
    "console": { "type": "console" },
    "file": {
      "type": "file",
      "filename": "logs/pmtiles.log"
    }
  }
}
```

## 许可证

MIT