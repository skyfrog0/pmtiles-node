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

function ZxyToID(z, x, y) {
  let acc = (Math.pow(2, z * 2) - 1) / 3;
  let n = z - 1;
  for (let s = Math.pow(2, n); s > 0; s >>= 1) {
    const rx = s & x;
    const ry = s & y;
    acc += ((3 * rx) ^ ry) * Math.pow(2, n);
    [x, y] = rotate(s, x, y, rx, ry);
    n--;
  }
  return Math.floor(acc);
}

function IDToZxy(tileId) {
  const temp = 3 * tileId + 1;
  let z = Math.floor(Math.log2(temp)) / 2;
  z = Math.floor(z);
  
  const acc = (Math.pow(2, z * 2) - 1) / 3;
  let t = tileId - acc;
  let tx = 0, ty = 0;
  
  for (let a = 0; a < z; a++) {
    const s = Math.pow(2, a);
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    [tx, ty] = rotate(s, tx, ty, rx, ry);
    tx += rx * Math.pow(2, a);
    ty += ry * Math.pow(2, a);
    t >>= 2;
  }
  
  return { z: Math.floor(z), x: Math.floor(tx), y: Math.floor(ty) };
}

module.exports = {
  ZxyToID,
  IDToZxy
};