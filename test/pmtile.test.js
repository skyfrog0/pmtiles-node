const fs = require('fs');
const path = require('path');
const { Buffer } = require('buffer');
const { PMTile, COMPRESSION, TILE_TYPE } = require('../lib/pmtile');
const { ZxyToID, IDToZxy } = require('../lib/tileId');
const { deserializeHeader, HEADER_V3_LEN, serializeHeader } = require('../lib/header');

async function testTileId() {
  console.log('Testing TileID encoding...');
  
  const z = 5, x = 10, y = 15;
  const tileId = ZxyToID(z, x, y);
  const decoded = IDToZxy(tileId);
  
  console.log(`ZxyToID(${z}, ${x}, ${y}) = ${tileId}`);
  console.log(`IDToZxy(${tileId}) = z:${decoded.z}, x:${decoded.x}, y:${decoded.y}`);
  
  if (decoded.z === z && decoded.x === x && decoded.y === y) {
    console.log('✓ TileID encoding test passed');
  } else {
    console.log('✗ TileID encoding test failed');
    process.exit(1);
  }
}

async function testHeader() {
  console.log('Testing Header serialization...');
  
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
  
  console.log(`Header serialized length: ${serialized.length}`);
  
  if (serialized.length !== HEADER_V3_LEN) {
    console.log('✗ Header serialization test failed: wrong length');
    process.exit(1);
  }
  
  const deserialized = deserializeHeader(serialized);
  
  console.log(`Original specVersion: ${header.specVersion}, Deserialized: ${deserialized.specVersion}`);
  console.log(`Original rootOffset: ${header.rootOffset}, Deserialized: ${deserialized.rootOffset}`);
  console.log(`Original clustered: ${header.clustered}, Deserialized: ${deserialized.clustered}`);
  
  if (deserialized.specVersion !== header.specVersion) {
    console.log('✗ Header deserialization test failed: specVersion mismatch');
    process.exit(1);
  }
  if (deserialized.rootOffset !== header.rootOffset) {
    console.log('✗ Header deserialization test failed: rootOffset mismatch');
    process.exit(1);
  }
  if (deserialized.clustered !== header.clustered) {
    console.log('✗ Header deserialization test failed: clustered mismatch');
    process.exit(1);
  }
  
  console.log('✓ Header serialization test passed');
}

async function testWriteRead() {
  console.log('Testing PMTiles write and read...');
  
  const tempPath = path.join(__dirname, 'test_output.pmtiles');
  
  try {
    const pmtile = new PMTile();
    pmtile.setTileType(TILE_TYPE.MVT);
    pmtile.setTileCompression(COMPRESSION.GZIP);
    pmtile.setMetadata({ name: 'Test Tiles' });
    
    const testTiles = [];
    for (let z = 0; z <= 2; z++) {
      const size = Math.pow(2, z);
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          const tileData = Buffer.from(`Tile data for z=${z},x=${x},y=${y}`);
          testTiles.push({ z, x, y, data: tileData });
        }
      }
    }
    
    pmtile.addTiles(testTiles);
    await pmtile.write(tempPath);
    
    console.log(`Created PMTiles file with ${testTiles.length} tiles`);
    
    const readPmtile = await PMTile.open(tempPath);
    const metadata = await readPmtile.readMetadata();
    
    console.log(`Header: specVersion=${readPmtile.header.specVersion}, clustered=${readPmtile.header.clustered}`);
    console.log(`Metadata: ${JSON.stringify(metadata)}`);
    
    const testTile = await readPmtile.readTile(1, 0, 0);
    if (testTile) {
      console.log(`Read tile (1,0,0): ${testTile.length} bytes`);
    }
    
    await readPmtile.close();
    
    console.log('✓ PMTiles write/read test passed');
    
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

async function main() {
  await testTileId();
  await testHeader();
  await testWriteRead();
  
  console.log('\nAll tests passed!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});