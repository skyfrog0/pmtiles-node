const { serializeEntries, createEntry } = require('./directory');
const { COMPRESSION } = require('./header');

const TARGET_ROOT_LEN = 16384 - 127;

function buildRootsLeaves(entries, leafSize, compression) {
  const rootEntries = [];
  let leavesBytes = Buffer.alloc(0);
  let numLeaves = 0;
  
  for (let idx = 0; idx < entries.length; idx += leafSize) {
    numLeaves++;
    const end = Math.min(idx + leafSize, entries.length);
    const leafEntries = entries.slice(idx, end);
    const serialized = serializeEntries(leafEntries, compression);
    
    rootEntries.push(createEntry(
      entries[idx].tileId,
      leavesBytes.length,
      serialized.length,
      0
    ));
    
    leavesBytes = Buffer.concat([leavesBytes, serialized]);
  }
  
  const rootBytes = serializeEntries(rootEntries, compression);
  return { rootBytes, leavesBytes, numLeaves };
}

function buildDirectories(entries, compression = COMPRESSION.GZIP) {
  if (entries.length === 0) {
    return { rootBytes: Buffer.alloc(0), leavesBytes: Buffer.alloc(0), numLeaves: 0 };
  }
  
  if (entries.length < 16384) {
    const testRootBytes = serializeEntries(entries, compression);
    if (testRootBytes.length <= TARGET_ROOT_LEN) {
      return { rootBytes: testRootBytes, leavesBytes: Buffer.alloc(0), numLeaves: 0 };
    }
  }
  
  let leafSize = Math.max(4096, entries.length / 3500);
  
  while (true) {
    const { rootBytes, leavesBytes, numLeaves } = buildRootsLeaves(entries, Math.floor(leafSize), compression);
    if (rootBytes.length <= TARGET_ROOT_LEN) {
      return { rootBytes, leavesBytes, numLeaves };
    }
    leafSize *= 1.2;
  }
}

function sortEntriesByTileId(entries) {
  return entries.sort((a, b) => {
    if (a.tileId < b.tileId) return -1;
    if (a.tileId > b.tileId) return 1;
    return 0;
  });
}

function deduplicateEntries(entries) {
  if (entries.length === 0) return entries;
  
  const sorted = sortEntriesByTileId(entries);
  const deduplicated = [];
  
  let current = { ...sorted[0] };
  
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    
    if (next.tileId === current.tileId + current.runLength + BigInt(1) &&
        next.offset === current.offset + current.length) {
      current.runLength = next.tileId - current.tileId + next.runLength;
      current.length = (current.offset + current.length) - next.offset + next.length;
    } else {
      deduplicated.push(current);
      current = { ...next };
    }
  }
  
  deduplicated.push(current);
  return deduplicated;
}

module.exports = {
  buildRootsLeaves,
  buildDirectories,
  sortEntriesByTileId,
  deduplicateEntries
};