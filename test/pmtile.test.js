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

async function testWriteStreaming() {
  console.log('Testing PMTiles writeStreaming with MD5 dedup...');

  const outputPath = path.join(__dirname, 'test_streaming_output.pmtiles');
  const tempTilePath = path.join(__dirname, 'test_streaming_tiledata.tmp');

  try {
    // 构造 0..2 全部层级的 21 个瓦片，其中 (1,1,0) 与 (1,1,1) 内容相同用于验证去重
    const testTiles = [];
    for (let z = 0; z <= 2; z++) {
      const size = Math.pow(2, z);
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          testTiles.push({ z, x, y });
        }
      }
    }

    const duplicateContent = Buffer.from('duplicate content for dedup test');
    function tileDataFor(z, x, y) {
      if ((z === 1 && x === 1 && y === 0) || (z === 1 && x === 1 && y === 1)) {
        return duplicateContent;
      }
      return Buffer.from(`Tile data for z=${z},x=${x},y=${y}`);
    }

    // 写入临时瓦片数据文件，做内存版 MD5 去重
    const crypto = require('crypto');
    const md5Index = new Map();
    const entries = [];
    let offset = 0;

    // 先按 tileId 排序
    const sortedTiles = testTiles
      .map((t) => ({ ...t, tileId: BigInt(ZxyToID(t.z, t.x, t.y)) }))
      .sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));

    const writeStream = fs.createWriteStream(tempTilePath);
    for (const t of sortedTiles) {
      const data = tileDataFor(t.z, t.x, t.y);
      const md5 = crypto.createHash('md5').update(data).digest('hex');
      let entryOffset;
      let entryLength;
      const cached = md5Index.get(md5);
      if (cached) {
        entryOffset = cached.offset;
        entryLength = cached.length;
      } else {
        entryOffset = BigInt(offset);
        entryLength = BigInt(data.length);
        await new Promise((resolve, reject) => {
          writeStream.write(data, (err) => err ? reject(err) : resolve());
        });
        offset += data.length;
        md5Index.set(md5, { offset: entryOffset, length: entryLength });
      }
      entries.push({
        tileId: t.tileId,
        offset: entryOffset,
        length: entryLength,
        runLength: BigInt(1)
      });
    }
    await new Promise((resolve, reject) => {
      writeStream.end((err) => err ? reject(err) : resolve());
    });

    const totalRawSize = testTiles.reduce((sum, t) => sum + tileDataFor(t.z, t.x, t.y).length, 0);
    const tempStat = fs.statSync(tempTilePath);
    console.log(`  total raw size: ${totalRawSize}, dedup temp file size: ${tempStat.size}`);
    if (tempStat.size >= totalRawSize) {
      console.log('✗ Dedup did not reduce temp file size');
      process.exit(1);
    }

    // 调用 writeStreaming
    const pmtile = new PMTile();
    pmtile.setTileType(TILE_TYPE.MVT);
    pmtile.setTileCompression(COMPRESSION.GZIP);
    pmtile.setMetadata({ name: 'Streaming Test' });

    await pmtile.writeStreaming(outputPath, entries, tempTilePath);

    console.log(`  Created streaming PMTiles with ${entries.length} entries, ${md5Index.size} unique contents`);

    // 读回验证
    const readPmtile = await PMTile.open(outputPath);
    console.log(`  Header: addressed=${readPmtile.header.addressedTilesCount}, entries=${readPmtile.header.tileEntriesCount}, contents=${readPmtile.header.tileContentsCount}`);

    if (Number(readPmtile.header.tileEntriesCount) !== entries.length) {
      console.log(`✗ tileEntriesCount mismatch: expected ${entries.length}, got ${readPmtile.header.tileEntriesCount}`);
      process.exit(1);
    }
    if (Number(readPmtile.header.tileContentsCount) !== md5Index.size) {
      console.log(`✗ tileContentsCount mismatch: expected ${md5Index.size}, got ${readPmtile.header.tileContentsCount}`);
      process.exit(1);
    }
    if (Number(readPmtile.header.tileContentsCount) >= Number(readPmtile.header.tileEntriesCount)) {
      console.log('✗ tileContentsCount should be < tileEntriesCount for dedup case');
      process.exit(1);
    }

    // 逐瓦片读回验证内容
    for (const t of testTiles) {
      const tile = await readPmtile.readTile(t.z, t.x, t.y);
      if (!tile) {
        console.log(`✗ Missing tile z=${t.z} x=${t.x} y=${t.y}`);
        process.exit(1);
      }
      const expected = tileDataFor(t.z, t.x, t.y);
      if (!tile.equals(expected)) {
        console.log(`✗ Content mismatch for z=${t.z} x=${t.x} y=${t.y}`);
        process.exit(1);
      }
    }
    await readPmtile.close();

    console.log('✓ PMTiles writeStreaming test passed');
  } finally {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (fs.existsSync(tempTilePath)) fs.unlinkSync(tempTilePath);
  }
}

async function main() {
  await testTileId();
  await testHeader();
  await testWriteRead();
  await testWriteStreaming();

  console.log('\nAll tests passed!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});