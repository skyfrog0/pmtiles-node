const { ZxyToID, IDToZxy } = require('../lib/tileId');

const [z,x,y] = [4, 12, 6];
const tileId = ZxyToID(z, x, y);
const decoded = IDToZxy(tileId);

console.log(`x=${x}, y=${y}, z=${z}`);
console.log(`tileId=${tileId}, decodedXYZ=${JSON.stringify(decoded)}`);