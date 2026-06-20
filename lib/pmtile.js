const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const log4js = require('log4js');
const { HEADER_V3_LEN, COMPRESSION, TILE_TYPE, createDefaultHeader, serializeHeader, deserializeHeader, serializeMetadata, deserializeMetadata } = require('./header');
const { createEntry, deserializeEntries, findTile } = require('./directory');
const { buildDirectories, sortEntriesByTileId } = require('./leafDictionary');
const { ZxyToID, IDToZxy } = require('./tileId');

log4js.configure(path.join(__dirname, '../config/log4js.config.json'));
const logger = log4js.getLogger('pmtiles');

class PMTile {
  constructor() {
    this.header = createDefaultHeader();
    this.entries = [];
    this.tileData = Buffer.alloc(0);
    this.metadata = {};
    this.filePath = null;
    this.fileHandle = null;
  }

  static async open(filePath) {
    const pmtile = new PMTile();
    pmtile.filePath = filePath;
    
    pmtile.fileHandle = await fs.promises.open(filePath, 'r');
    const headerBuffer = Buffer.alloc(HEADER_V3_LEN);
    await pmtile.fileHandle.read(headerBuffer, 0, HEADER_V3_LEN, 0);
    pmtile.header = deserializeHeader(headerBuffer);
    
    return pmtile;
  }

  async readMetadata() {
    if (!this.fileHandle) {
      throw new Error('File not open');
    }
    
    if (this.header.metadataLength === 0) {
      return {};
    }
    
    const metadataBuffer = Buffer.alloc(Number(this.header.metadataLength));
    await this.fileHandle.read(metadataBuffer, 0, Number(this.header.metadataLength), Number(this.header.metadataOffset));
    return await deserializeMetadata(metadataBuffer, this.header.internalCompression);
  }

  async readRootDirectory() {
    if (!this.fileHandle) {
      throw new Error('File not open');
    }
    
    if (this.header.rootLength === 0) {
      return [];
    }
    
    const rootBuffer = Buffer.alloc(Number(this.header.rootLength));
    await this.fileHandle.read(rootBuffer, 0, Number(this.header.rootLength), Number(this.header.rootOffset));
    return deserializeEntries(rootBuffer, this.header.internalCompression);
  }

  async readLeafDirectory(offset, length) {
    if (!this.fileHandle) {
      throw new Error('File not open');
    }
    
    const leafBuffer = Buffer.alloc(Number(length));
    const leafOffset = Number(this.header.leafDirectoryOffset) + Number(offset);
    await this.fileHandle.read(leafBuffer, 0, Number(length), leafOffset);
    return deserializeEntries(leafBuffer, this.header.internalCompression);
  }

  async readTile(z, x, y) {
    if (!this.fileHandle) {
      throw new Error('File not open');
    }
    
    const tileId = BigInt(ZxyToID(z, x, y));
    let entries = await this.readRootDirectory();
    
    let { entry, found } = findTile(entries, tileId);
    
    if (!found) {
      return null;
    }
    
    if (this.header.leafDirectoryLength > 0 && entry.runLength === BigInt(0)) {
      const leafEntries = await this.readLeafDirectory(entry.offset, entry.length);
      ({ entry, found } = findTile(leafEntries, tileId));
      if (!found) {
        return null;
      }
    }
    
    const tileOffset = Number(this.header.tileDataOffset) + Number(entry.offset);
    const tileLength = Number(entry.length);
    const tileBuffer = Buffer.alloc(tileLength);
    await this.fileHandle.read(tileBuffer, 0, tileLength, tileOffset);
    
    return tileBuffer;
  }

  async close() {
    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }

  addTile(z, x, y, data) {
    const tileId = BigInt(ZxyToID(z, x, y));
    
    this.entries.push({
      tileId: tileId,
      offset: BigInt(0),
      length: BigInt(data.length),
      runLength: BigInt(0),
      z: z,
      x: x,
      y: y,
      data: data
    });
  }

  addTiles(tiles) {
    for (const tile of tiles) {
      this.addTile(tile.z, tile.x, tile.y, tile.data);
    }
  }

  async write(outputPath, options = {}) {
    const { tempDir = path.dirname(outputPath) } = options;

    logger.info(`Writing PMTiles file to ${outputPath}`);

    if (this.entries.length === 0) {
      throw new Error('No tiles to write');
    }

    const sortedEntries = sortEntriesByTileId(this.entries);

    let tileDataOffset = 0;
    const remappedEntries = [];

    for (const entry of sortedEntries) {
      remappedEntries.push({
        tileId: entry.tileId,
        offset: BigInt(tileDataOffset),
        length: entry.length,
        runLength: BigInt(0),
        data: entry.data
      });
      tileDataOffset += Number(entry.length);
    }

    const { rootBytes, leavesBytes } = buildDirectories(remappedEntries, this.header.internalCompression);

    const metadataBytes = await serializeMetadata(this.metadata, this.header.internalCompression);

    const finalHeader = { ...this.header };
    finalHeader.rootOffset = BigInt(HEADER_V3_LEN);
    finalHeader.rootLength = BigInt(rootBytes.length);
    finalHeader.metadataOffset = finalHeader.rootOffset + finalHeader.rootLength;
    finalHeader.metadataLength = BigInt(metadataBytes.length);
    finalHeader.leafDirectoryOffset = finalHeader.metadataOffset + finalHeader.metadataLength;
    finalHeader.leafDirectoryLength = BigInt(leavesBytes.length);
    finalHeader.tileDataOffset = finalHeader.leafDirectoryOffset + finalHeader.leafDirectoryLength;
    finalHeader.tileDataLength = BigInt(tileDataOffset);
    finalHeader.addressedTilesCount = BigInt(this.entries.length);
    finalHeader.tileEntriesCount = BigInt(remappedEntries.length);
    finalHeader.tileContentsCount = BigInt(remappedEntries.length);
    finalHeader.clustered = true;

    this._updateBounds(remappedEntries, finalHeader);

    const headerBytes = serializeHeader(finalHeader);

    const tempFilePath = path.join(tempDir, `pmtiles_temp_${Date.now()}.dat`);

    const tempHandle = await fs.promises.open(tempFilePath, 'w');

    try {
      await tempHandle.write(headerBytes);
      await tempHandle.write(rootBytes);
      await tempHandle.write(metadataBytes);
      await tempHandle.write(leavesBytes);

      for (const entry of remappedEntries) {
        await tempHandle.write(entry.data);
      }

      await tempHandle.close();

      await fs.promises.rename(tempFilePath, outputPath);
      logger.info(`PMTiles file written successfully: ${outputPath}`);
    } catch (err) {
      await tempHandle.close();
      await fs.promises.unlink(tempFilePath).catch(() => {});
      throw err;
    }
  }

  /**
   * 流式写入：瓦片数据来自已写好的临时文件，避免在内存中持有全部瓦片数据。
   *
   * entries 需已按 tileId 升序排列，并包含正确的 offset/length/runLength（offset/length
   * 指向 tempTileDataPath 文件内的位置）。本方法仅负责组装 Header/Root/Metadata/Leaves
   * 并把临时瓦片数据流式追加到最终 PMTiles 文件末尾。
   *
   * @param {string} outputPath 最终 PMTiles 文件路径
   * @param {Array} entries 目录条目数组（已按 tileId 升序，含 offset/length/runLength）
   * @param {string} tempTileDataPath 已写好的临时瓦片数据文件路径
   * @param {object} options { tempDir, metadata, tileType, tileCompression }
   */
  async writeStreaming(outputPath, entries, tempTileDataPath, options = {}) {
    const { tempDir = path.dirname(outputPath) } = options;

    logger.info(`Writing PMTiles file (streaming) to ${outputPath}`);

    if (!entries || entries.length === 0) {
      throw new Error('No entries to write');
    }

    // 取临时瓦片数据文件大小作为 tileDataLength
    const tempStat = await fs.promises.stat(tempTileDataPath);
    const tileDataLength = tempStat.size;

    // 构建目录（entries 已按 tileId 升序，runLength 已设置好）
    const { rootBytes, leavesBytes } = buildDirectories(entries, this.header.internalCompression);

    // 元数据：优先用 options.metadata，否则用 this.metadata
    const metadata = options.metadata !== undefined ? options.metadata : this.metadata;
    const metadataBytes = await serializeMetadata(metadata, this.header.internalCompression);

    // 计算 header
    const finalHeader = { ...this.header };
    if (options.tileType !== undefined) finalHeader.tileType = options.tileType;
    if (options.tileCompression !== undefined) finalHeader.tileCompression = options.tileCompression;

    finalHeader.rootOffset = BigInt(HEADER_V3_LEN);
    finalHeader.rootLength = BigInt(rootBytes.length);
    finalHeader.metadataOffset = finalHeader.rootOffset + finalHeader.rootLength;
    finalHeader.metadataLength = BigInt(metadataBytes.length);
    finalHeader.leafDirectoryOffset = finalHeader.metadataOffset + finalHeader.metadataLength;
    finalHeader.leafDirectoryLength = BigInt(leavesBytes.length);
    finalHeader.tileDataOffset = finalHeader.leafDirectoryOffset + finalHeader.leafDirectoryLength;
    finalHeader.tileDataLength = BigInt(tileDataLength);
    finalHeader.addressedTilesCount = BigInt(entries.length);
    finalHeader.tileEntriesCount = BigInt(entries.length);

    // 计算唯一的瓦片内容数（不同 offset+length 组合的数量）
    const uniqueContents = new Set();
    for (const entry of entries) {
      uniqueContents.add(`${entry.offset}_${entry.length}`);
    }
    finalHeader.tileContentsCount = BigInt(uniqueContents.size);
    finalHeader.clustered = true;

    this._updateBounds(entries, finalHeader);

    const headerBytes = serializeHeader(finalHeader);

    // 写到临时文件再 rename，保持原子落盘
    const tempFilePath = path.join(tempDir, `pmtiles_temp_${Date.now()}.dat`);
    const tempHandle = await fs.promises.open(tempFilePath, 'w');

    try {
      await tempHandle.write(headerBytes);
      await tempHandle.write(rootBytes);
      await tempHandle.write(metadataBytes);
      await tempHandle.write(leavesBytes);
      await tempHandle.close();

      // 流式追加瓦片数据：从临时瓦片文件读取并写入目标临时文件
      const readStream = fs.createReadStream(tempTileDataPath, { highWaterMark: 1024 * 1024 });
      const writeStream = fs.createWriteStream(tempFilePath, { flags: 'a' });

      await new Promise((resolve, reject) => {
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        readStream.pipe(writeStream);
      });

      await fs.promises.rename(tempFilePath, outputPath);
      logger.info(`PMTiles file written successfully (streaming): ${outputPath}`);
    } catch (err) {
      try { await tempHandle.close(); } catch (_) {}
      await fs.promises.unlink(tempFilePath).catch(() => {});
      throw err;
    }
  }

  _updateBounds(entries, header) {
    if (entries.length === 0) return;
    
    let minZoom = 255, maxZoom = 0;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    
    for (const entry of entries) {
      const { z, x, y } = IDToZxy(Number(entry.tileId));
      
      minZoom = Math.min(minZoom, z);
      maxZoom = Math.max(maxZoom, z);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    
    header.minZoom = minZoom;
    header.maxZoom = maxZoom;
    
    const tilesPerSide = Math.pow(2, maxZoom);
    const lonMin = (minX / tilesPerSide) * 360 - 180;
    const lonMax = ((maxX + 1) / tilesPerSide) * 360 - 180;
    const latMin = this._tileYToLat(maxY + 1, maxZoom);
    const latMax = this._tileYToLat(minY, maxZoom);
    
    header.minLonE7 = Math.round(lonMin * 10000000);
    header.maxLonE7 = Math.round(lonMax * 10000000);
    header.minLatE7 = Math.round(latMin * 10000000);
    header.maxLatE7 = Math.round(latMax * 10000000);
    
    header.centerLonE7 = Math.round(((lonMin + lonMax) / 2) * 10000000);
    header.centerLatE7 = Math.round(((latMin + latMax) / 2) * 10000000);
    header.centerZoom = Math.floor((minZoom + maxZoom) / 2);
  }

  _tileYToLat(y, z) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  setMetadata(metadata) {
    this.metadata = { ...this.metadata, ...metadata };
  }

  setTileType(tileType) {
    this.header.tileType = tileType;
  }

  setTileCompression(compression) {
    this.header.tileCompression = compression;
  }
}

module.exports = {
  PMTile,
  COMPRESSION,
  TILE_TYPE,
  ZxyToID,
  IDToZxy
};