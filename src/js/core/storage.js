// storage.js — two interchangeable key/value stores with the same async API.
//   MemoryStore : tests, and "nothing touches disk" mode
//   IdbStore    : IndexedDB in the browser (structured clone keeps Uint8Arrays intact)
// Neither ever leaves the device. There is no sync, no backup, no cloud.

export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { const v = this.m.get(k); return v === undefined ? undefined : structuredClone(v); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async delete(k) { this.m.delete(k); }
  async clear() { this.m.clear(); }
  async keys() { return [...this.m.keys()]; }
}

export class IdbStore {
  constructor(dbName = 'murmur', storeName = 'kv') { this.dbName = dbName; this.storeName = storeName; this.db = null; }

  async open() {
    if (this.destroyed) throw new Error('storage was erased');
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async #tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      if (this.destroyed) { reject(new Error('storage was erased')); return; }
      let tx;
      try { tx = db.transaction(this.storeName, mode); } catch (e) { reject(e); return; }
      const st = tx.objectStore(this.storeName);
      const req = fn(st);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  get(k) { return this.#tx('readonly', (s) => s.get(k)); }
  put(k, v) { return this.#tx('readwrite', (s) => s.put(v, k)); }
  delete(k) { return this.#tx('readwrite', (s) => s.delete(k)); }
  clear() { return this.#tx('readwrite', (s) => s.clear()); }
  keys() { return this.#tx('readonly', (s) => s.getAllKeys()); }

  /** Panic wipe: drop the whole database, not just its rows. */
  async destroy() {
    this.destroyed = true; // late writes must fail, never silently re-create the database
    if (this.db) { this.db.close(); this.db = null; }
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess = req.onblocked = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * One vault "slot" inside a shared store. Slot B lives under the "b:" prefix; slot A is
 * everything else (so installs from before slots existed are slot A unchanged).
 * clear() only removes this slot's keys.
 */
export class SlotStore {
  constructor(inner, prefix, exclude = []) { Object.assign(this, { inner, prefix, exclude }); }
  #mine(k) { return typeof k === 'string' && k.startsWith(this.prefix) && !this.exclude.some((x) => k.startsWith(x)); }
  get(k) { return this.inner.get(this.prefix + k); }
  put(k, v) { return this.inner.put(this.prefix + k, v); }
  delete(k) { return this.inner.delete(this.prefix + k); }
  async keys() { return (await this.inner.keys()).filter((k) => this.#mine(k)).map((k) => k.slice(this.prefix.length)); }
  async clear() { for (const k of (await this.inner.keys()).filter((k) => this.#mine(k))) await this.inner.delete(k); }
}
