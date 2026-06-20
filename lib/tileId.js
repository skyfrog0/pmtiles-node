/**
 * Hilbert curve tile ID encoding following PMTiles v3 spec.
 * Reference: https://github.com/protomaps/PMTiles
 */

function rotate(n, x, y, rx, ry) {
  if (ry === 0) {
    if (rx !== 0) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    return [y, x];
  }
  return [x, y];
}

/**
 * Convert Z,X,Y to a Hilbert TileID.
 */
function ZxyToID(z, x, y) {
  if (z > 26) {
    throw new Error("Tile zoom level exceeds max safe number limit (26)");
  }
  if (x >= (1 << z) || y >= (1 << z)) {
    throw new Error("tile x/y outside zoom level bounds");
  }
  
  let acc = ((1 << z) * (1 << z) - 1) / 3;
  let a = z - 1;
  let [tx, ty] = [x, y];
  
  for (let s = 1 << a; s > 0; s >>= 1) {
    const rx = s & tx;
    const ry = s & ty;
    acc += ((3 * rx) ^ ry) * (1 << a);
    [tx, ty] = rotate(s, tx, ty, rx, ry);
    a--;
  }
  
  return Math.floor(acc);
}

/**
 * Calculate Z from a TileID.
 * Uses the formula: tileId = (4^z - 1) / 3 + innerId
 * where innerId is the position within a zoom level.
 */
function tileIdToZ(i) {
  // Find the smallest z such that (4^z - 1) / 3 > i
  // This is equivalent to: z > log4(3i + 1)
  // Using bit manipulation to find the position of highest set bit
  const c = 3 * i + 1;
  if (c < 0x100000000) {
    return 31 - Math.clz32(c);
  }
  return 63 - Math.clz32(c / 0x100000000);
}

/**
 * Convert a Hilbert TileID to Z,X,Y.
 */
function IDToZxy(tileId) {
  // First get z from tileId
  const z = tileIdToZ(tileId) >> 1;
  
  if (z > 26) {
    throw new Error("Tile zoom level exceeds max safe number limit (26)");
  }
  
  const acc = ((1 << z) * (1 << z) - 1) / 3;
  let t = tileId - acc;
  let x = 0;
  let y = 0;
  const n = 1 << z;
  
  for (let s = 1; s < n; s <<= 1) {
    const rx = s & (t >> 1);
    const ry = s & (t ^ rx);
    [x, y] = rotate(s, x, y, rx, ry);
    t = t >> 1;  // t = t / 2
    x += rx;
    y += ry;
  }
  
  return { z: Math.floor(z), x: Math.floor(x), y: Math.floor(y) };
}

module.exports = {
  ZxyToID,
  IDToZxy
};