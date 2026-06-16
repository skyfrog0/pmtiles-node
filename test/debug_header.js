const { serializeHeader, deserializeHeader, HEADER_V3_LEN } = require('../lib/header');
const { COMPRESSION, TILE_TYPE } = require('../lib/header');

const header = {
  specVersion: 3,
  rootOffset: 127,
  rootLength: 1000,
  metadataOffset: 1127,
  metadataLength: 500,
  leafDirectoryOffset: 1627,
  leafDirectoryLength: 2000,
  tileDataOffset: 3627,
  tileDataLength: 1000000,
  addressedTilesCount: 10000,
  tileEntriesCount: 10000,
  tileContentsCount: 10000,
  clustered: true,
  internalCompression: COMPRESSION.GZIP,
  tileCompression: COMPRESSION.GZIP,
  tileType: TILE_TYPE.MVT,
  minZoom: 0,
  maxZoom: 14,
  minLonE7: -1800000000,
  minLatE7: -900000000,
  maxLonE7: 1800000000,
  maxLatE7: 900000000,
  centerZoom: 7,
  centerLonE7: 0,
  centerLatE7: 0
};

const serialized = serializeHeader(header);

console.log('Serialized buffer (first 20 bytes):');
for (let i = 0; i < 20; i++) {
  console.log(`  [${i}]: 0x${serialized[i].toString(16).padStart(2, '0')}`);
}

console.log('\nRoot offset bytes (positions 8-15):');
for (let i = 8; i < 16; i++) {
  console.log(`  [${i}]: 0x${serialized[i].toString(16).padStart(2, '0')}`);
}

const deserialized = deserializeHeader(serialized);
console.log(`\nDeserialized rootOffset: ${deserialized.rootOffset}`);
console.log(`Expected rootOffset: ${header.rootOffset}`);

console.log(`\nRoot offset as uint32le at position 8: ${serialized.readUInt32LE(8)}`);
console.log(`Root offset as uint32le at position 12: ${serialized.readUInt32LE(12)}`);