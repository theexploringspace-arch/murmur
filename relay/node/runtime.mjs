// runtime.mjs — just enough of the Durable Objects runtime to run inbox.js in
// Node: SQLite storage (node:sqlite), alarms, and hibernatable WebSockets.
// Mirrors the Cloudflare API surface the relay uses, nothing more.
import { DatabaseSync } from 'node:sqlite';

class Cursor {
  constructor(rows) { this.rows = rows; }
  toArray() { return this.rows; }
  one() { if (this.rows.length !== 1) throw new Error(`Expected exactly one row, got ${this.rows.length}`); return this.rows[0]; }
}

export class FakeState {
  constructor(name) {
    this.name = name; this.db = new DatabaseSync(':memory:'); this.sockets = new Set(); this.alarmAt = null; this.timer = null; this.obj = null;
    const db = this.db;
    this.storage = {
      sql: { exec: (q, ...params) => {
        const st = db.prepare(q);
        return /^\s*(SELECT|PRAGMA)/i.test(q) ? new Cursor(st.all(...params)) : (st.run(...params), new Cursor([]));
      } },
      getAlarm: async () => this.alarmAt,
      setAlarm: async (t) => { this.alarmAt = +t; this.#schedule(); },
      deleteAlarm: async () => { this.alarmAt = null; clearTimeout(this.timer); },
    };
  }
  #schedule() {
    clearTimeout(this.timer);
    const delay = Math.max(0, this.alarmAt - Date.now());
    if (delay > 2 ** 31 - 1) return; // Node timers cap at ~24.8 days; tests call runAlarm() directly
    this.timer = setTimeout(() => this.runAlarm(), delay); this.timer.unref?.();
  }
  async runAlarm() { this.alarmAt = null; await this.obj.alarm(); }
  acceptWebSocket(ws) {
    this.sockets.add(ws);
    ws.onmessage = (m) => this.obj.webSocketMessage(ws, m);
    ws.onclose = (code) => { this.sockets.delete(ws); this.obj.webSocketClose(ws, code); };
  }
  getWebSockets() { return [...this.sockets]; }
}

/** Wraps a ws-lite Conn with the attachment API Cloudflare provides. */
export function hibernatable(conn) {
  let att = null;
  return Object.assign(conn, {
    serializeAttachment(v) { att = structuredClone(v); },
    deserializeAttachment() { return att && structuredClone(att); },
  });
}

/** A Durable Object namespace: one instance per name, like idFromName(). */
export class FakeNamespace {
  constructor(Klass, env) { this.Klass = Klass; this.env = env; this.objs = new Map(); }
  idFromName(n) { return n; }
  instance(name) {
    if (!this.objs.has(name)) { const st = new FakeState(name); st.obj = new this.Klass(st, this.env); this.objs.set(name, st); }
    return this.objs.get(name);
  }
  get(name) { const st = this.instance(name); return { fetch: (req) => st.obj.fetch(req) }; }
}
