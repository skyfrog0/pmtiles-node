const { Buffer } = require('buffer');
const zlib = require('zlib');
const { putUvarint, getUvarint } = require('./utils');
const { COMPRESSION } = require('./header');

function createEntry(tileId, offset, length, runLength = 0) {
  return {
    tileId: BigInt(tileId),
    offset: BigInt(offset),
    length: BigInt(length),
    runLength: BigInt(runLength)
  };
}

function serializeEntries(entries, compression) {
  const tmp = Buffer.alloc(10);
  
  const ids = [];
  const runLengths = [];
  const lengths = [];
  const offsets = [];
  
  let lastId = BigInt(0);
  for (const entry of entries) {
    ids.push(Number(entry.tileId - lastId));
    lastId = entry.tileId;
    runLengths.push(Number(entry.runLength));
    lengths.push(Number(entry.length));
  }
  
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && entries[i].offset === entries[i - 1].offset + entries[i - 1].length) {
      offsets.push(0);
    } else {
      offsets.push(Number(entries[i].offset + BigInt(1)));
    }
  }
  
  let totalSize = 0;
  
  totalSize += countUvarintBytes(entries.length);
  for (const id of ids) totalSize += countUvarintBytes(id);
  for (const rl of runLengths) totalSize += countUvarintBytes(rl);
  for (const len of lengths) totalSize += countUvarintBytes(len);
  for (const off of offsets) totalSize += countUvarintBytes(off);
  
  const uncompressed = Buffer.alloc(totalSize);
  let offset = 0;
  
  offset += putUvarint(uncompressed, entries.length, offset);
  for (const id of ids) offset += putUvarint(uncompressed, id, offset);
  for (const rl of runLengths) offset += putUvarint(uncompressed, rl, offset);
  for (const len of lengths) offset += putUvarint(uncompressed, len, offset);
  for (const off of offsets) offset += putUvarint(uncompressed, off, offset);
  
  if (compression === COMPRESSION.NO_COMPRESSION) {
    return uncompressed;
  } else if (compression === COMPRESSION.GZIP) {
    return zlib.gzipSync(uncompressed, { level: zlib.constants.Z_BEST_COMPRESSION });
  } else {
    throw new Error('Unsupported compression type');
  }
}

function deserializeEntries(buffer, compression) {
  let data = buffer;
  
  if (compression === COMPRESSION.GZIP) {
    data = zlib.gunzipSync(buffer);
  }
  
  const entries = [];
  let offset = 0;
  
  const { value: numEntries, bytesRead } = getUvarint(data, offset);
  offset += bytesRead;
  
  let lastId = BigInt(0);
  for (let i = 0; i < numEntries; i++) {
    const { value: delta, bytesRead: deltaBytes } = getUvarint(data, offset);
    offset += deltaBytes;
    const tileId = lastId + BigInt(delta);
    lastId = tileId;
    entries.push({
      tileId: tileId,
      offset: BigInt(0),
      length: BigInt(0),
      runLength: BigInt(0)
    });
  }
  
  for (let i = 0; i < numEntries; i++) {
    const { value: runLength, bytesRead: rlBytes } = getUvarint(data, offset);
    offset += rlBytes;
    entries[i].runLength = BigInt(runLength);
  }
  
  for (let i = 0; i < numEntries; i++) {
    const { value: length, bytesRead: lenBytes } = getUvarint(data, offset);
    offset += lenBytes;
    entries[i].length = BigInt(length);
  }
  
  for (let i = 0; i < numEntries; i++) {
    const { value: tmp, bytesRead: offBytes } = getUvarint(data, offset);
    offset += offBytes;
    if (i > 0 && tmp === 0) {
      entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    } else {
      entries[i].offset = BigInt(tmp) - BigInt(1);
    }
  }
  
  return entries;
}

function findTile(entries, tileId) {
  let m = 0;
  let n = entries.length - 1;
  
  while (m <= n) {
    const k = (n + m) >> 1;
    const cmp = tileId - entries[k].tileId;
    
    if (cmp > 0) {
      m = k + 1;
    } else if (cmp < 0) {
      n = k - 1;
    } else {
      return { entry: entries[k], found: true };
    }
  }
  
  if (n >= 0) {
    if (entries[n].runLength === BigInt(0)) {
      return { entry: entries[n], found: true };
    }
    if (tileId - entries[n].tileId < entries[n].runLength) {
      return { entry: entries[n], found: true };
    }
  }
  
  return { entry: null, found: false };
}

function countUvarintBytes(value) {
  let count = 0;
  do {
    count++;
    value >>>= 7;
  } while (value > 0);
  return count;
}

module.exports = {
  createEntry,
  serializeEntries,
  deserializeEntries,
  findTile
};