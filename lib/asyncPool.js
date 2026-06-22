'use strict';

/**
 * 简易并发池：限制 worker 并发数为 size，按 items 顺序返回结果。
 */
class AsyncPool {
  /**
   * @param {Array} items
   * @param {number} size 最大并发数
   * @param {function(item, index): Promise} worker
   * @returns {Promise<Array>} 按 items 顺序排列的结果
   */
  static async run(items, size, worker) {
    const results = new Array(items.length);
    let nextIdx = 0;

    async function runOne() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= items.length) return;
        results[idx] = await worker(items[idx], idx);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(size, items.length); i++) {
      workers.push(runOne());
    }
    await Promise.all(workers);
    return results;
  }
}

module.exports = { AsyncPool };
