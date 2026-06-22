'use strict';

/**
 * 有序写入队列 — 保证按 idx 顺序串行写入共享文件句柄。
 * 用于 clustered PMTiles 场景：瓦片数据写入顺序必须与 tileId 顺序一致。
 *
 * 用法：
 *   const writer = new OrderedWriter(fileHandle);
 *   const offset = await writer.write(idx, buffer);  // 缓存未命中，写入数据
 *   await writer.write(idx, null);                    // 缓存命中 / 跳过，仅推进
 */
class OrderedWriter {
  /**
   * @param {fs.promises.FileHandle} fileHandle 已打开的写入文件句柄
   */
  constructor(fileHandle) {
    this._fileHandle = fileHandle;
    this._writeChain = Promise.resolve();
    this._pendingWrites = new Map(); // idx -> { data, resolve, reject }
    this._orderedIdx = 0;
    this._bytesWritten = 0;
  }

  /** 已写入的字节数 */
  get bytesWritten() {
    return this._bytesWritten;
  }

  /**
   * 提交写入请求。保证 idx 顺序被严格遵循：
   *   - idx === 当前期待序号 → 立即写入
   *   - idx > 当前期待序号  → 缓存，等前面的写入完成后触发
   *   - data === null       → 仅推进序号，不写入数据
   *
   * @param {number} idx items 中的原始序号
   * @param {Buffer|null} data 瓦片数据，null 表示仅推进
   * @returns {Promise<bigint|null>} data 写入的偏移量，null 表示未写入
   */
  write(idx, data) {
    return new Promise((resolve, reject) => {
      if (idx !== this._orderedIdx) {
        this._pendingWrites.set(idx, { data, resolve, reject });
        return;
      }
      this._doWrite(data, resolve, reject);
    });
  }

  _doWrite(data, resolve, reject) {
    this._orderedIdx++;
    const p = this._writeChain.then(async () => {
      if (data === null) return null;
      const offset = BigInt(this._bytesWritten);
      await this._fileHandle.write(data);
      this._bytesWritten += data.length;
      return offset;
    });
    this._writeChain = p.catch(() => {});
    p.then(resolve, reject);
    this._flushPending();
  }

  _flushPending() {
    while (this._pendingWrites.has(this._orderedIdx)) {
      const { data, resolve, reject } = this._pendingWrites.get(this._orderedIdx);
      this._pendingWrites.delete(this._orderedIdx);
      this._doWrite(data, resolve, reject);
    }
  }
}

module.exports = { OrderedWriter };
