const { Buffer } = require('buffer');

function putUint64LE(buffer, value, offset) {
  console.log(`putUint64LE: value=${value}, offset=${offset}`);
  console.log(`  low 32 bits: ${value & 0xFFFFFFFF}`);
  console.log(`  high 32 bits: ${(value >>> 32) & 0xFFFFFFFF}`);
  buffer.writeUInt32LE(value & 0xFFFFFFFF, offset);
  buffer.writeUInt32LE((value >>> 32) & 0xFFFFFFFF, offset + 4);
}

function getUint64LE(buffer, offset) {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  return (high * 0x100000000) + low;
}

const buffer = Buffer.alloc(20);
const value = 127;

putUint64LE(buffer, value, 8);

console.log('\nBuffer after putUint64LE:');
for (let i = 8; i < 20; i++) {
  console.log(`  [${i}]: 0x${buffer[i].toString(16).padStart(2, '0')}`);
}

console.log(`\nReading back: ${getUint64LE(buffer, 8)}`);

console.log(`\nTesting with large value:`);
putUint64LE(buffer, 0x123456789ABCDEF0, 8);
console.log('Buffer after putUint64LE with large value:');
for (let i = 8; i < 20; i++) {
  console.log(`  [${i}]: 0x${buffer[i].toString(16).padStart(2, '0')}`);
}
console.log(`Reading back: ${getUint64LE(buffer, 8).toString(16)}`);