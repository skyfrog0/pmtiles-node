const { Buffer } = require('buffer');

function putUint64LE(buffer, value, offset) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

function getUint64LE(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset));
}

function putUint32LE(buffer, value, offset) {
  buffer.writeUInt32LE(value, offset);
}

function getUint32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function putInt32LE(buffer, value, offset) {
  buffer.writeInt32LE(value, offset);
}

function getInt32LE(buffer, offset) {
  return buffer.readInt32LE(offset);
}

function putUvarint(buffer, value, offset) {
  let i = offset;
  while (value >= 0x80) {
    buffer[i++] = value & 0x7F | 0x80;
    value >>>= 7;
  }
  buffer[i++] = value;
  return i - offset;
}

function getUvarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  let byte;
  
  do {
    if (i >= buffer.length) {
      throw new Error('Buffer overflow in uvarint');
    }
    byte = buffer[i++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
  } while (byte & 0x80);
  
  return { value: result, bytesRead: i - offset };
}

function writeString(buffer, str, offset) {
  const bytes = Buffer.from(str, 'utf8');
  bytes.copy(buffer, offset);
  return bytes.length;
}

function readString(buffer, offset, length) {
  return buffer.toString('utf8', offset, offset + length);
}

module.exports = {
  putUint64LE,
  getUint64LE,
  putUint32LE,
  getUint32LE,
  putInt32LE,
  getInt32LE,
  putUvarint,
  getUvarint,
  writeString,
  readString
};