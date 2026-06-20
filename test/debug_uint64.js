const { Buffer } = require('buffer');

function putUint64LE(buffer, value, offset) {
  console.log(`putUint64LE: value=${value} (0x${value.toString(16)}), offset=${offset}`);
  console.log(`  low 32 bits: ${BigInt(value) & 0xFFFFFFFFn}`);
  console.log(`  high 32 bits: ${(BigInt(value) >> 32n) & 0xFFFFFFFFn}`);
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

function getUint64LE(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  return value;  // 返回 BigInt 保持精度
}

const buffer = Buffer.alloc(20);
const value = 127;

putUint64LE(buffer, value, 8);

console.log('\nBuffer after putUint64LE:');
for (let i = 8; i < 16; i++) {
  console.log(`  [${i}]: 0x${buffer[i].toString(16).padStart(2, '0')}`);
}

console.log(`\nReading back: ${getUint64LE(buffer, 8)}`);

console.log(`\nTesting with large value:`);
putUint64LE(buffer, 0x123456789ABCDEF0n, 8);
console.log('Buffer after putUint64LE with large value:');
for (let i = 8; i < 16; i++) {
  console.log(`  [${i}]: 0x${buffer[i].toString(16).padStart(2, '0')}`);
}
console.log(`Reading back: ${getUint64LE(buffer, 8).toString(16)}`);

console.log('\n✓ uint64 test passed!');