const { Buffer } = require('buffer');
const zlib = require('zlib');
const { putUint64LE, getUint64LE, putUint32LE, getUint32LE, putInt32LE, getInt32LE, writeString } = require('./utils');

const HEADER_V3_LEN = 127;
const MAGIC = 'PMTiles';

const COMPRESSION = {
  UNKNOWN: 0,
  NO_COMPRESSION: 1,
  GZIP: 2,
  BROTLI: 3,
  ZSTD: 4
};

const TILE_TYPE = {
  UNKNOWN: 0,
  MVT: 1,
  PNG: 2,
  JPEG: 3,
  WEBP: 4,
  AVIF: 5,
  MLT: 6
};

function createDefaultHeader() {
  return {
    specVersion: 3,
    rootOffset: 0,
    rootLength: 0,
    metadataOffset: 0,
    metadataLength: 0,
    leafDirectoryOffset: 0,
    leafDirectoryLength: 0,
    tileDataOffset: 0,
    tileDataLength: 0,
    addressedTilesCount: 0,
    tileEntriesCount: 0,
    tileContentsCount: 0,
    clustered: false,
    internalCompression: COMPRESSION.GZIP,
    tileCompression: COMPRESSION.GZIP,
    tileType: TILE_TYPE.MVT,
    minZoom: 0,
    maxZoom: 14,
    minLonE7: -1800000000,
    minLatE7: -900000000,
    maxLonE7: 1800000000,
    maxLatE7: 900000000,
    centerZoom: 0,
    centerLonE7: 0,
    centerLatE7: 0
  };
}

function serializeHeader(header) {
  const buffer = Buffer.alloc(HEADER_V3_LEN);
  writeString(buffer, MAGIC, 0);
  
  buffer[7] = header.specVersion;
  
  putUint64LE(buffer, header.rootOffset, 8);
  putUint64LE(buffer, header.rootLength, 16);
  putUint64LE(buffer, header.metadataOffset, 24);
  putUint64LE(buffer, header.metadataLength, 32);
  putUint64LE(buffer, header.leafDirectoryOffset, 40);
  putUint64LE(buffer, header.leafDirectoryLength, 48);
  putUint64LE(buffer, header.tileDataOffset, 56);
  putUint64LE(buffer, header.tileDataLength, 64);
  putUint64LE(buffer, header.addressedTilesCount, 72);
  putUint64LE(buffer, header.tileEntriesCount, 80);
  putUint64LE(buffer, header.tileContentsCount, 88);
  
  buffer[96] = header.clustered ? 0x1 : 0x0;
  buffer[97] = header.internalCompression;
  buffer[98] = header.tileCompression;
  buffer[99] = header.tileType;
  
  buffer[100] = header.minZoom;
  buffer[101] = header.maxZoom;
  
  putInt32LE(buffer, header.minLonE7, 102);
  putInt32LE(buffer, header.minLatE7, 106);
  putInt32LE(buffer, header.maxLonE7, 110);
  putInt32LE(buffer, header.maxLatE7, 114);
  
  buffer[118] = header.centerZoom;
  putInt32LE(buffer, header.centerLonE7, 119);
  putInt32LE(buffer, header.centerLatE7, 123);
  
  return buffer;
}

function deserializeHeader(buffer) {
  if (buffer.length < HEADER_V3_LEN) {
    throw new Error('Invalid header length');
  }
  
  const magic = buffer.toString('utf8', 0, 7);
  if (magic !== MAGIC) {
    throw new Error('Invalid magic number. Not a PMTiles file');
  }
  
  const specVersion = buffer[7];
  if (specVersion > 3) {
    throw new Error(`Unsupported spec version: ${specVersion}`);
  }
  
  return {
    specVersion: specVersion,
    rootOffset: getUint64LE(buffer, 8),
    rootLength: getUint64LE(buffer, 16),
    metadataOffset: getUint64LE(buffer, 24),
    metadataLength: getUint64LE(buffer, 32),
    leafDirectoryOffset: getUint64LE(buffer, 40),
    leafDirectoryLength: getUint64LE(buffer, 48),
    tileDataOffset: getUint64LE(buffer, 56),
    tileDataLength: getUint64LE(buffer, 64),
    addressedTilesCount: getUint64LE(buffer, 72),
    tileEntriesCount: getUint64LE(buffer, 80),
    tileContentsCount: getUint64LE(buffer, 88),
    clustered: buffer[96] === 0x1,
    internalCompression: buffer[97],
    tileCompression: buffer[98],
    tileType: buffer[99],
    minZoom: buffer[100],
    maxZoom: buffer[101],
    minLonE7: getInt32LE(buffer, 102),
    minLatE7: getInt32LE(buffer, 106),
    maxLonE7: getInt32LE(buffer, 110),
    maxLatE7: getInt32LE(buffer, 114),
    centerZoom: buffer[118],
    centerLonE7: getInt32LE(buffer, 119),
    centerLatE7: getInt32LE(buffer, 123)
  };
}

async function serializeMetadata(metadata, compression) {
  const jsonBytes = Buffer.from(JSON.stringify(metadata));
  
  if (compression === COMPRESSION.NO_COMPRESSION) {
    return jsonBytes;
  } else if (compression === COMPRESSION.GZIP) {
    return new Promise((resolve, reject) => {
      zlib.gzip(jsonBytes, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  } else {
    throw new Error('Unsupported compression type');
  }
}

async function deserializeMetadata(buffer, compression) {
  let jsonBytes;
  
  if (compression === COMPRESSION.NO_COMPRESSION) {
    jsonBytes = buffer;
  } else if (compression === COMPRESSION.GZIP) {
    jsonBytes = await new Promise((resolve, reject) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  } else {
    throw new Error('Unsupported compression type');
  }
  
  return JSON.parse(jsonBytes.toString('utf8'));
}

module.exports = {
  HEADER_V3_LEN,
  COMPRESSION,
  TILE_TYPE,
  createDefaultHeader,
  serializeHeader,
  deserializeHeader,
  serializeMetadata,
  deserializeMetadata
};