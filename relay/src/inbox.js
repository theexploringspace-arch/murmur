// inbox.js — one Durable Object = one mailbox. Pure logic, no Cloudflare imports,
// so the exact same class runs in tests (Node) and in production (Workers).
//
// WHAT IT STORES: opaque ciphertext rows {id, at, size, data}. Nothing else —
// no names, no keys, no IP addresses, no logs. A row is deleted the moment the
// owner acknowledges it, or after RETENTION_MS (30 days), whichever is first.
//
// WHO CAN DO WHAT
//   anyone who knows the ADDRESS  → POST a message (that's how contacts write)
//   only who knows the SECRET     → read + delete (address = H("murmur/inbox/v1"‖secret))
// The address is 256 bits, so mailboxes cannot be found by guessing.

export const RETENTION_MS = 30 * 24 * 3600 * 1000;
export const MAX_MESSAGE = 1024 * 1024;           // client chunks bigger payloads
export const MAX_BOX_BYTES = 64 * 1024 * 1024;
export const MAX_BOX_MESSAGES = 5000;
export const AUTH_TIMEOUT_MS = 10_000;
const LABEL = new TextEncoder().encode('murmur/inbox/v1');

const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
export const ADDRESS_RE = /^[A-Za-z0-9_-]{43}$/;

export async function addressOf(secret) {
  const buf = new Uint8Array(LABEL.length + 1 + secret.length);
  buf.set(LABEL); buf.set(secret, LABEL.length + 1);
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

export function makeInbox(Base) {
  return class Inbox extends Base {
    constructor(ctx, env) {
      super(ctx, env);
      this.ctx = ctx; this.env = env;
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS m (id BLOB PRIMARY KEY, at INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL)');
      // Keep-alive pings are answered by the runtime itself without waking the object.
      if (ctx.setWebSocketAutoResponse && globalThis.WebSocketRequestResponsePair)
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }

    async fetch(request) {
      const addr = request.headers.get('x-murmur-addr');
      if (!ADDRESS_RE.test(addr || '')) return new Response('bad address', { status: 400 });
      if (request.headers.get('Upgrade') === 'websocket') {
        const pair = new WebSocketPair();
        this.accept(pair[1], addr);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (request.method === 'POST') return this.deposit(new Uint8Array(await request.arrayBuffer()));
      return new Response('method not allowed', { status: 405 });
    }

    /** Hibernatable accept. Exposed so the Node test server can hand over its own sockets. */
    accept(ws, addr) {
      this.ctx.acceptWebSocket(ws);
      ws.serializeAttachment({ addr, authed: false, since: Date.now() });
    }

    async deposit(data) {
      this.prune();
      if (data.length === 0 || data.length > MAX_MESSAGE) return new Response('message too large', { status: 413 });
      const { n, bytes } = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM m').one();
      if (n >= MAX_BOX_MESSAGES || bytes + data.length > MAX_BOX_BYTES) return new Response('mailbox full', { status: 507 });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const at = Date.now();
      this.ctx.storage.sql.exec('INSERT INTO m (id, at, size, data) VALUES (?, ?, ?, ?)', id, at, data.length, data);
      await this.armAlarm(at + RETENTION_MS);
      const frame = new Uint8Array(16 + data.length); frame.set(id); frame.set(data, 16);
      for (const ws of this.ctx.getWebSockets()) {
        if (ws.deserializeAttachment()?.authed) try { ws.send(frame); } catch {}
      }
      return new Response(null, { status: 201 });
    }

    async webSocketMessage(ws, msg) {
      if (msg === 'ping') { ws.send('pong'); return; } // normally answered by the runtime's auto-response
      const att = ws.deserializeAttachment() || {};
      let m;
      try { m = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); } catch { return ws.close(1003, 'bad frame'); }
      if (m.t === 'auth') {
        let ok = false;
        try { ok = (await addressOf(unb64u(String(m.secret)))) === att.addr; } catch {}
        if (!ok) return ws.close(4001, 'unauthorized');
        ws.serializeAttachment({ ...att, authed: true });
        this.prune();
        for (const r of this.ctx.storage.sql.exec('SELECT id, data FROM m ORDER BY at, rowid').toArray()) {
          const id = new Uint8Array(r.id), data = new Uint8Array(r.data);
          const frame = new Uint8Array(16 + data.length); frame.set(id); frame.set(data, 16);
          ws.send(frame);
        }
        ws.send(JSON.stringify({ t: 'synced' }));
        return;
      }
      if (!att.authed) return ws.close(4001, 'unauthorized');
      if (m.t === 'ack' && Array.isArray(m.ids)) {
        for (const s of m.ids.slice(0, 500)) {
          try { this.ctx.storage.sql.exec('DELETE FROM m WHERE id = ?', unb64u(String(s))); } catch {}
        }
        if (this.count() === 0) await this.ctx.storage.deleteAlarm?.();
      }
    }

    webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {} }
    webSocketError() {}

    async alarm() {
      this.prune();
      const next = this.ctx.storage.sql.exec('SELECT MIN(at) AS at FROM m').one().at;
      if (next != null) await this.armAlarm(next + RETENTION_MS);
    }

    prune() { this.ctx.storage.sql.exec('DELETE FROM m WHERE at < ?', Date.now() - RETENTION_MS); }
    count() { return this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM m').one().n; }
    async armAlarm(when) {
      const cur = await this.ctx.storage.getAlarm();
      if (cur == null || cur > when) await this.ctx.storage.setAlarm(when);
    }
  };
}
