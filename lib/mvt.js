const { Buffer } = require('buffer');

class MVTLayer {
  constructor(name, version = 2, extent = 4096) {
    this.name = name;
    this.version = version;
    this.extent = extent;
    this.features = [];
    this.keys = [];
    this.values = [];
  }

  addFeature(feature) {
    const { id, type, geometry, properties } = feature;
    
    this.features.push({
      id: id !== undefined ? id : 0,
      type: this._encodeType(type),
      geometry: this._encodeGeometry(geometry),
      properties: this._encodeProperties(properties)
    });
  }

  _encodeType(type) {
    const types = {
      'Unknown': 0,
      'Point': 1,
      'LineString': 2,
      'Polygon': 3
    };
    return types[type] || 0;
  }

  _encodeGeometry(geometry) {
    const encoded = [];
    
    if (!geometry || geometry.length === 0) {
      return encoded;
    }

    const type = geometry.type;
    const coordinates = geometry.coordinates;

    if (type === 'Point') {
      encoded.push(9); // MoveTo
      encoded.push(1); // count
      const [x, y] = coordinates;
      encoded.push(...this._encodeCommand(x, y));
    } else if (type === 'LineString') {
      encoded.push(2); // LineTo
      encoded.push(coordinates.length);
      let lastX = 0, lastY = 0;
      for (const [x, y] of coordinates) {
        encoded.push(...this._encodeCommand(x - lastX, y - lastY));
        lastX = x;
        lastY = y;
      }
      encoded.push(7); // ClosePath
    } else if (type === 'Polygon') {
      for (const ring of coordinates) {
        encoded.push(3); // LineTo
        encoded.push(ring.length);
        let lastX = 0, lastY = 0;
        for (const [x, y] of ring) {
          encoded.push(...this._encodeCommand(x - lastX, y - lastY));
          lastX = x;
          lastY = y;
        }
        encoded.push(15); // ClosePath
      }
    }

    return encoded;
  }

  _encodeCommand(x, y) {
    const encodedX = (x << 1) ^ (x >> 31);
    const encodedY = (y << 1) ^ (y >> 31);
    return [encodedX, encodedY];
  }

  _encodeProperties(properties) {
    const encoded = [];
    
    for (const [key, value] of Object.entries(properties)) {
      let keyIndex = this.keys.indexOf(key);
      if (keyIndex === -1) {
        keyIndex = this.keys.length;
        this.keys.push(key);
      }
      
      let valueIndex = this._findValueIndex(value);
      if (valueIndex === -1) {
        valueIndex = this.values.length;
        this.values.push(this._encodeValue(value));
      }
      
      encoded.push(keyIndex, valueIndex);
    }
    
    return encoded;
  }

  _findValueIndex(value) {
    const encoded = this._encodeValue(value);
    return this.values.findIndex(v => 
      v.type === encoded.type && v.value === encoded.value
    );
  }

  _encodeValue(value) {
    if (value === null) {
      return { type: 'nullValue', value: null };
    } else if (typeof value === 'string') {
      return { type: 'stringValue', value: value };
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { type: 'intValue', value: value };
      } else {
        return { type: 'doubleValue', value: value };
      }
    } else if (typeof value === 'boolean') {
      return { type: 'boolValue', value: value };
    } else if (Array.isArray(value)) {
      return { type: 'arrayValue', value: value };
    } else if (typeof value === 'object') {
      return { type: 'objectValue', value: value };
    }
    return { type: 'nullValue', value: null };
  }

  toBuffer() {
    const buffers = [];
    
    // Layer name (tag 1)
    const nameBuffer = Buffer.from(this.name);
    buffers.push(Buffer.from([1]));
    buffers.push(this._encodeVarint(nameBuffer.length));
    buffers.push(nameBuffer);
    
    // Features (tag 2)
    buffers.push(Buffer.from([2]));
    buffers.push(this._encodeVarint(this.features.length));
    for (const feature of this.features) {
      buffers.push(this._encodeFeature(feature));
    }
    
    // Keys (tag 3)
    buffers.push(Buffer.from([3]));
    buffers.push(this._encodeVarint(this.keys.length));
    for (const key of this.keys) {
      const keyBuffer = Buffer.from(key);
      buffers.push(this._encodeVarint(keyBuffer.length));
      buffers.push(keyBuffer);
    }
    
    // Values (tag 4)
    buffers.push(Buffer.from([4]));
    buffers.push(this._encodeVarint(this.values.length));
    for (const value of this.values) {
      buffers.push(this._encodeValueBuffer(value));
    }
    
    // Version (tag 5)
    buffers.push(Buffer.from([5]));
    buffers.push(this._encodeVarint(this.version));
    
    // Extent (tag 15)
    buffers.push(Buffer.from([15]));
    buffers.push(this._encodeVarint(this.extent));
    
    return Buffer.concat(buffers);
  }

  _encodeFeature(feature) {
    const buffers = [];
    
    // ID (tag 1)
    buffers.push(Buffer.from([1]));
    buffers.push(this._encodeVarint(feature.id));
    
    // Type (tag 3)
    buffers.push(Buffer.from([3]));
    buffers.push(this._encodeVarint(feature.type));
    
    // Geometry (tag 4)
    buffers.push(Buffer.from([4]));
    buffers.push(this._encodeVarint(feature.geometry.length));
    for (const cmd of feature.geometry) {
      buffers.push(this._encodeVarint(cmd));
    }
    
    // Properties (tag 5)
    buffers.push(Buffer.from([5]));
    buffers.push(this._encodeVarint(feature.properties.length));
    for (const prop of feature.properties) {
      buffers.push(this._encodeVarint(prop));
    }
    
    return Buffer.concat(buffers);
  }

  _encodeValueBuffer(value) {
    const buffers = [];
    
    switch (value.type) {
      case 'stringValue':
        buffers.push(Buffer.from([1]));
        const strBuffer = Buffer.from(value.value);
        buffers.push(this._encodeVarint(strBuffer.length));
        buffers.push(strBuffer);
        break;
      case 'floatValue':
        buffers.push(Buffer.from([2]));
        const floatBuffer = Buffer.alloc(4);
        floatBuffer.writeFloatLE(value.value, 0);
        buffers.push(floatBuffer);
        break;
      case 'doubleValue':
        buffers.push(Buffer.from([3]));
        const doubleBuffer = Buffer.alloc(8);
        doubleBuffer.writeDoubleLE(value.value, 0);
        buffers.push(doubleBuffer);
        break;
      case 'intValue':
        buffers.push(Buffer.from([4]));
        buffers.push(this._encodeVarint(value.value));
        break;
      case 'uintValue':
        buffers.push(Buffer.from([5]));
        buffers.push(this._encodeVarint(value.value));
        break;
      case 'sintValue':
        buffers.push(Buffer.from([6]));
        buffers.push(this._encodeVarint(value.value));
        break;
      case 'boolValue':
        buffers.push(Buffer.from([7]));
        buffers.push(this._encodeVarint(value.value ? 1 : 0));
        break;
      default:
        buffers.push(Buffer.from([0]));
    }
    
    return Buffer.concat(buffers);
  }

  _encodeVarint(value) {
    const bytes = [];
    while (value >= 0x80) {
      bytes.push((value & 0x7F) | 0x80);
      value >>>= 7;
    }
    bytes.push(value);
    return Buffer.from(bytes);
  }
}

class MVTTile {
  constructor() {
    this.layers = [];
  }

  static _encodeVarint(value) {
    const bytes = [];
    while (value >= 0x80) {
      bytes.push((value & 0x7F) | 0x80);
      value >>>= 7;
    }
    bytes.push(value);
    return Buffer.from(bytes);
  }

  addLayer(layer) {
    if (layer instanceof MVTLayer) {
      this.layers.push(layer);
    } else {
      throw new Error('Layer must be an instance of MVTLayer');
    }
  }

  toBuffer() {
    const buffers = [];
    
    for (const layer of this.layers) {
      const layerBuffer = layer.toBuffer();
      buffers.push(Buffer.from([3]));
      buffers.push(MVTTile._encodeVarint(layerBuffer.length));
      buffers.push(layerBuffer);
    }
    
    return Buffer.concat(buffers);
  }

  static fromBuffer(buffer) {
    const tile = new MVTTile();
    let offset = 0;
    
    while (offset < buffer.length) {
      const { value: tag, bytesRead: tagBytes } = MVTTile._decodeVarint(buffer, offset);
      offset += tagBytes;
      const { value: length, bytesRead: lenBytes } = MVTTile._decodeVarint(buffer, offset);
      offset += lenBytes;
      
      if (tag === 3) { // Layer
        const layerData = buffer.slice(offset, offset + length);
        const layer = MVTTile._parseLayer(layerData);
        tile.addLayer(layer);
        offset += length;
      } else {
        offset += length;
      }
    }
    
    return tile;
  }

  static _parseLayer(buffer) {
    let offset = 0;
    let name = '';
    let version = 2;
    let extent = 4096;
    const features = [];
    const keys = [];
    const values = [];
    
    while (offset < buffer.length) {
      const { value: tag, bytesRead: tagBytes } = MVTTile._decodeVarint(buffer, offset);
      offset += tagBytes;
      const { value: length, bytesRead: lenBytes } = MVTTile._decodeVarint(buffer, offset);
      offset += lenBytes;
      
      switch (tag) {
        case 1: // Name
          name = buffer.toString('utf8', offset, offset + length);
          offset += length;
          break;
        case 5: // Version
          const { value: ver } = MVTTile._decodeVarint(buffer, offset);
          version = ver;
          offset += length;
          break;
        case 15: // Extent
          const { value: ext } = MVTTile._decodeVarint(buffer, offset);
          extent = ext;
          offset += length;
          break;
        case 2: // Features
          const featureEnd = offset + length;
          while (offset < featureEnd) {
            const feature = MVTTile._parseFeature(buffer, offset, featureEnd, keys, values);
            if (feature) {
              features.push(feature);
              offset = feature.offset;
            } else {
              break;
            }
          }
          break;
        case 3: // Keys
          keys.push(buffer.toString('utf8', offset, offset + length));
          offset += length;
          break;
        case 4: // Values
          const value = MVTTile._parseValue(buffer, offset, length);
          values.push(value);
          offset += length;
          break;
        default:
          offset += length;
          break;
      }
    }
    
    const layer = new MVTLayer(name, version, extent);
    layer.keys = keys;
    layer.values = values;
    layer.features = features;
    
    return layer;
  }

  static _parseFeature(buffer, offset, endOffset, keys, values) {
    let id = 0;
    let type = 0;
    let geometry = [];
    let properties = [];
    let currentOffset = offset;
    
    while (currentOffset < endOffset) {
      const { value: tag, bytesRead: tagBytes } = MVTTile._decodeVarint(buffer, currentOffset);
      currentOffset += tagBytes;
      const { value: length, bytesRead: lenBytes } = MVTTile._decodeVarint(buffer, currentOffset);
      currentOffset += lenBytes;
      
      switch (tag) {
        case 1: // ID
          const { value: idVal } = MVTTile._decodeVarint(buffer, currentOffset);
          id = idVal;
          currentOffset += length;
          break;
        case 3: // Type
          type = buffer[currentOffset];
          currentOffset += length;
          break;
        case 4: // Geometry
          const geomEnd = currentOffset + length;
          while (currentOffset < geomEnd) {
            const { value: cmd } = MVTTile._decodeVarint(buffer, currentOffset);
            geometry.push(cmd);
            const cmdBytes = MVTTile._varintLength(cmd);
            currentOffset += cmdBytes;
          }
          break;
        case 5: // Properties
          const propEnd = currentOffset + length;
          while (currentOffset < propEnd) {
            const { value: prop } = MVTTile._decodeVarint(buffer, currentOffset);
            properties.push(prop);
            const propBytes = MVTTile._varintLength(prop);
            currentOffset += propBytes;
          }
          break;
        default:
          currentOffset += length;
          break;
      }
      
      // Check if we've parsed a complete feature (has type and geometry)
      if (type !== 0 && geometry.length > 0) {
        break;
      }
    }
    
    return { id, type, geometry, properties, offset: currentOffset };
  }

  static _parseValue(buffer, offset, length) {
    const type = buffer[offset];
    const valueOffset = offset + 1;
    
    switch (type) {
      case 1: // String
        const { value: strLen } = MVTTile._decodeVarint(buffer, valueOffset);
        const strBytes = MVTTile._varintLength(strLen);
        return { type: 'stringValue', value: buffer.toString('utf8', valueOffset + strBytes, valueOffset + strBytes + strLen) };
      case 2: // Float
        return { type: 'floatValue', value: buffer.readFloatLE(valueOffset) };
      case 3: // Double
        return { type: 'doubleValue', value: buffer.readDoubleLE(valueOffset) };
      case 4: // Int
        const { value: intVal } = MVTTile._decodeVarint(buffer, valueOffset);
        return { type: 'intValue', value: intVal };
      case 5: // Uint
        const { value: uintVal } = MVTTile._decodeVarint(buffer, valueOffset);
        return { type: 'uintValue', value: uintVal };
      case 6: // Sint
        const { value: sintVal } = MVTTile._decodeVarint(buffer, valueOffset);
        return { type: 'sintValue', value: sintVal };
      case 7: // Bool
        return { type: 'boolValue', value: buffer[valueOffset] === 1 };
      default:
        return { type: 'nullValue', value: null };
    }
  }

  static _decodeVarint(buffer, offset) {
    let result = 0;
    let shift = 0;
    let i = offset;
    let byte;
    
    do {
      byte = buffer[i++];
      result |= (byte & 0x7F) << shift;
      shift += 7;
    } while (byte & 0x80);
    
    return { value: result, bytesRead: i - offset };
  }

  static _varintLength(value) {
    let count = 0;
    do {
      count++;
      value >>>= 7;
    } while (value > 0);
    return count;
  }

  getLayer(name) {
    return this.layers.find(layer => layer.name === name);
  }

  getLayers() {
    return this.layers;
  }
}

module.exports = {
  MVTLayer,
  MVTTile
};