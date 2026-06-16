# PMTiles 读写系统实现计划

## 1. 需求分析

### 1.1 核心功能需求
- 基于 Node.js + JavaScript 语言实现
- 支持 PMTiles v3 规范
- 实现 PMTiles 文件的读取和写入功能
- 支持从 MongoDB 读取指定数据集的瓦片并导出为 PMTiles 单文件
- 自动切分 Leaf Dictionaries（叶子字典）
- 大数据量瓦片支持：TileID 排序、瓦片数据导出到临时文件

### 1.2 PMTiles v3 规范要点
PMTiles 是一种用于存储瓦片数据的单文件格式，核心结构包括：
- **Header**: 文件头（127字节），包含元数据和索引信息
- **Root Directory**: 根目录，记录瓦片索引或叶子目录指针
- **Metadata**: JSON 元数据（可选压缩）
- **Leaf Directory**: 叶子目录，用于优化大文件的随机访问性能
- **Tile Data**: 实际的瓦片数据

### 1.3 MongoDB 数据读取需求
- 支持从 MongoDB 集合中读取瓦片数据
- 支持按数据集名称筛选
- 瓦片数据结构假设包含：zoom、x、y、tile_data（二进制数据）

### 1.4 新增依赖需求
- **pmtiles@4.4.1**: 利用其中的部分函数和结构
- **log4js**: 日志输出框架

## 2. 技术架构

### 2.1 项目结构
```
.
├── package.json                    # 项目配置
├── lib/
│   ├── pmtile.js                  # PMTiles 核心读写类
│   ├── header.js                  # Header 处理模块
│   ├── directory.js               # Directory 处理模块
│   ├── leafDictionary.js          # Leaf Dictionary 处理模块
│   ├── tileId.js                  # TileID 编码/解码（Hilbert曲线）
│   └── utils.js                   # 工具函数
├── scripts/
│   └── exportFromMongo.js         # MongoDB 导出脚本
├── config/
│   └── log4js.config.js           # log4js 配置
└── test/
    └── pmtile.test.js             # 测试用例
```

### 2.2 核心类设计

#### PMTile 类
- **构造函数**: 接受文件路径或 Buffer
- **readHeader()**: 读取并解析文件头
- **readDirectory()**: 读取瓦片目录
- **readTile(z, x, y)**: 读取指定瓦片
- **write(outputPath)**: 写入 PMTiles 文件
- **addTile(z, x, y, data)**: 添加单个瓦片
- **buildDirectories()**: 构建目录结构

#### HeaderV3 结构（参考 Go 实现）
```javascript
{
  specVersion: Number,              // 规范版本，固定为3
  rootOffset: Number,               // 根目录偏移
  rootLength: Number,               // 根目录长度
  metadataOffset: Number,           // 元数据偏移
  metadataLength: Number,           // 元数据长度
  leafDirectoryOffset: Number,      // 叶子目录偏移
  leafDirectoryLength: Number,      // 叶子目录长度
  tileDataOffset: Number,           // 瓦片数据偏移
  tileDataLength: Number,           // 瓦片数据长度
  addressedTilesCount: Number,      // 寻址瓦片数量
  tileEntriesCount: Number,         // 瓦片条目数量
  tileContentsCount: Number,        // 瓦片内容数量
  clustered: Boolean,               // 是否聚类
  internalCompression: Number,      // 内部压缩类型
  tileCompression: Number,          // 瓦片压缩类型
  tileType: Number,                 // 瓦片类型
  minZoom: Number,                  // 最小缩放级别
  maxZoom: Number,                  // 最大缩放级别
  minLonE7: Number,                 // 最小经度（×10^7）
  minLatE7: Number,                 // 最小纬度（×10^7）
  maxLonE7: Number,                 // 最大经度（×10^7）
  maxLatE7: Number,                 // 最大纬度（×10^7）
  centerZoom: Number,               // 中心点缩放级别
  centerLonE7: Number,              // 中心点经度（×10^7）
  centerLatE7: Number               // 中心点纬度（×10^7）
}
```

#### EntryV3 结构
```javascript
{
  tileId: Number,                   // TileID（Hilbert曲线编码）
  offset: Number,                   // 数据偏移
  length: Number,                   // 数据长度
  runLength: Number                 // 连续瓦片数
}
```

### 2.3 Leaf Dictionary 自动切分策略（参考 Go 实现）
- **目标根目录大小**: 16384 - HeaderV3LenBytes = 16257 字节
- **切分算法**: 
  1. 如果条目数少于 16384 且序列化后小于目标大小，直接作为根目录
  2. 否则按 Leaf Size 切分为多个叶子目录
  3. Leaf Size 初始值 = 条目数 / 3500，最小 4096
  4. 迭代调整 Leaf Size 直到根目录大小符合要求

### 2.4 TileID 编码（Hilbert 曲线）
- **ZxyToID(z, x, y)**: 将 ZXY 坐标转换为 Hilbert TileID
- **IDToZxy(tileId)**: 将 TileID 转换回 ZXY 坐标

## 3. 实现步骤

### 3.1 步骤一：初始化项目
- 创建 package.json
- 安装依赖：pmtiles@4.4.1、log4js、mongodb

### 3.2 步骤二：配置 log4js
- 创建 log4js.config.js
- 配置控制台和文件输出

### 3.3 步骤三：实现工具函数模块
- 字节序转换（小端序）
- 缓冲区读写操作
- Varint 编码/解码

### 3.4 步骤四：实现 TileID 模块
- ZxyToID: ZXY 转 Hilbert TileID
- IDToZxy: TileID 转 ZXY

### 3.5 步骤五：实现 Header 模块
- SerializeHeader: Header 序列化
- DeserializeHeader: Header 反序列化
- 元数据压缩/解压

### 3.6 步骤六：实现 Directory 模块
- SerializeEntries: 条目序列化
- DeserializeEntries: 条目反序列化
- FindTile: 二分查找瓦片

### 3.7 步骤七：实现 Leaf Dictionary 模块
- buildRootsLeaves: 构建根目录和叶子目录
- BuildDirectories: 自动切分目录

### 3.8 步骤八：实现 PMTile 核心类
- 文件读写操作
- 瓦片添加和检索
- 完整文件生成（支持临时文件处理大数据量）

### 3.9 步骤九：实现 MongoDB 导出脚本
- MongoDB 连接配置
- 瓦片数据查询（按数据集名称筛选）
- TileID 排序
- PMTiles 文件生成

### 3.10 步骤十：编写测试用例
- Header 读写测试
- Directory 读写测试
- TileID 编码测试
- 完整文件生成测试

## 4. 依赖清单

| 依赖名称 | 版本 | 用途 |
|---------|------|------|
| pmtiles | ^4.4.1 | PMTiles 规范支持和工具函数 |
| log4js | ^6.0.0 | 日志输出框架 |
| mongodb | ^6.0.0 | MongoDB 数据库驱动 |
| zlib | 内置 | GZIP 压缩支持 |

## 5. 大数据量处理策略

### 5.1 内存管理
- **临时文件存储**: 瓦片数据先写入临时文件，避免内存溢出
- **分批处理**: 按 TileID 排序后分批写入
- **流式写入**: 使用 WriteStream 进行流式输出

### 5.2 排序策略
- 使用外部排序算法处理大数据量
- TileID 排序确保聚类存储

## 6. 风险与注意事项

### 6.1 潜在风险
1. **大文件内存管理**: 处理大型瓦片数据集时可能导致内存溢出
   - 解决方案：采用临时文件和流式写入

2. **Leaf Dictionary 切分复杂度**: 切分算法需要考虑空间索引的均匀分布
   - 解决方案：参考 Go 实现中的迭代调整策略

3. **MongoDB 查询性能**: 大规模瓦片数据查询可能较慢
   - 解决方案：创建合适的索引，使用批量查询和游标

### 6.2 注意事项
- 严格遵守 PMTiles v3 规范的字节顺序（小端序）和数据结构
- 处理瓦片数据时注意压缩格式（gzip）
- 确保文件偏移量计算准确无误
- 使用 log4js 记录关键操作和错误信息

## 7. 输出文件清单

| 文件路径 | 描述 |
|---------|------|
| package.json | 项目配置文件 |
| config/log4js.config.js | log4js 配置 |
| lib/utils.js | 工具函数模块 |
| lib/tileId.js | TileID 编码模块 |
| lib/header.js | Header 处理模块 |
| lib/directory.js | Directory 处理模块 |
| lib/leafDictionary.js | Leaf Dictionary 处理模块 |
| lib/pmtile.js | PMTiles 核心类 |
| scripts/exportFromMongo.js | MongoDB 导出脚本 |
| test/pmtile.test.js | 测试用例 |