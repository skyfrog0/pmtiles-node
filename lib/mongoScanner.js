'use strict';

const MAX_ZOOM = 20;

/**
 * MongoDB 瓦片扫描与查询工具。
 * 所有方法均为 static，无状态。
 */
class MongoScanner {
  /**
   * 构造查询条件：dataset / zoom 范围过滤。
   */
  static buildQuery({ datasetName, minZoom, maxZoom }) {
    const query = {};
    /*if (datasetName) {
      query.dataset = datasetName;
    }*/
    if (minZoom !== undefined || maxZoom !== undefined) {
      const zoomCond = {};
      if (minZoom !== undefined) zoomCond.$gte = minZoom;
      if (maxZoom !== undefined) zoomCond.$lte = maxZoom;
      query.zoom = zoomCond;
    }
    return query;
  }

  /**
   * 校验 minZoom / maxZoom 参数合法性。
   */
  static validateZoomRange(minZoom, maxZoom) {
    if (minZoom !== undefined && (minZoom < 0 || minZoom > MAX_ZOOM)) {
      throw new Error(`--min-zoom must be in [0, ${MAX_ZOOM}], got ${minZoom}`);
    }
    if (maxZoom !== undefined && (maxZoom < 0 || maxZoom > MAX_ZOOM)) {
      throw new Error(`--max-zoom must be in [0, ${MAX_ZOOM}], got ${maxZoom}`);
    }
    if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
      throw new Error(`--min-zoom (${minZoom}) must be <= --max-zoom (${maxZoom})`);
    }
  }

  /**
   * 扫描满足条件的 xyz 坐标列表。
   * @param {Collection} collection MongoDB collection
   * @param {object} query 基础过滤条件
   * @param {number} batchSize 游标 batchSize
   * @returns {Promise<Array<{z:number, x:number, y:number}>>}
   */
  static async scanXyz(collection, query, batchSize) {
    const xyzList = [];
    const cursor = collection
      .find(query, { projection: { _id: 0, zoom: 1, x: 1, y: 1 }, noCursorTimeout: true })
      .batchSize(batchSize)

    try {
      await cursor.forEach((doc) => {
        if (doc.zoom === undefined || doc.x === undefined || doc.y === undefined) {
          return; // skip malformed docs
        }
        xyzList.push({ z: doc.zoom, x: doc.x, y: doc.y });
      });
    } finally {
      await cursor.close();
    }
    return xyzList;
  }

  /**
   * 拉取单个 xyz 对应的所有分片，按 _id 升序拼接为完整瓦片 Buffer。
   * @param {Collection} collection MongoDB collection
   * @param {object} baseQuery 基础过滤条件
   * @param {number} z zoom
   * @param {number} x
   * @param {number} y
   * @returns {Promise<Buffer|null>}
   */
  static async fetchTile(collection, baseQuery, z, x, y) {
    const tileQuery = { ...baseQuery, zoom: z, x, y };
    // baseQuery 中可能含有 zoom 范围条件，已被精确值覆盖
    if (tileQuery.zoom && typeof tileQuery.zoom === 'object') {
      delete tileQuery.zoom;
      tileQuery.zoom = z;
    }
    const docs = await collection.find(tileQuery).sort({ _id: 1 }).toArray();
    if (docs.length === 0) return null;

    const buffers = docs
      .map((doc) => {
        if (!doc.tile_data) return null;
        // tile_data 可能是 BSON Binary（.buffer 是 ArrayBuffer，.length 是方法）、Buffer、或其他类 Buffer
        // 统一转为真正的 Buffer，避免 Buffer.concat 读到函数字符串作为 size
        if (Buffer.isBuffer(doc.tile_data)) return doc.tile_data;
        if (Buffer.isBuffer(doc.tile_data.buffer)) return doc.tile_data.buffer;
        if (doc.tile_data.buffer instanceof ArrayBuffer) {
          // BSON Binary: .position 是实际数据长度
          return Buffer.from(doc.tile_data.buffer, 0, doc.tile_data.position ?? doc.tile_data.buffer.byteLength);
        }
        return Buffer.from(doc.tile_data);
      })
      .filter((b) => b !== null);

    if (buffers.length === 0) return null;
    return Buffer.concat(buffers);
  }
}

module.exports = { MongoScanner };
