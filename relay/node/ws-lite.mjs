// ws-lite.mjs — a minimal RFC 6455 WebSocket server, so the relay can be tested
// locally with zero dependencies. Test/dev only; production uses Cloudflare.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new Conn(socket);
}

class Conn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frag = null; this.closed = false;
    this.onmessage = () => {}; this.onclose = () => {};
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.#parse(); });
    socket.on('close', () => this.#gone(1006));
    socket.on('error', () => this.#gone(1006));
  }
  #gone(code) { if (this.closed) return; this.closed = true; this.onclose(code); }
  #parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = b1 & 0x80; if (!masked) { this.socket.destroy(); return; } // clients MUST mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      const fin = b0 & 0x80, op = b0 & 0x0f;
      if (op === 8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; this.#frame(8, payload.subarray(0, 2)); this.socket.end(); this.#gone(code); return; }
      if (op === 9) { this.#frame(10, payload); continue; }
      if (op === 10) continue;
      if (op === 0) { if (!this.frag) { this.socket.destroy(); return; } this.frag.parts.push(payload); }
      else this.frag = { op, parts: [payload] };
      if (fin) {
        const data = Buffer.concat(this.frag.parts); const fop = this.frag.op; this.frag = null;
        this.onmessage(fop === 1 ? data.toString('utf8') : new Uint8Array(data));
      }
    }
  }
  #frame(op, payload) {
    if (this.closed && op !== 8) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(data) { if (typeof data === 'string') this.#frame(1, Buffer.from(data)); else this.#frame(2, Buffer.from(data)); }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code); p.write(reason, 2);
    this.#frame(8, p); this.closed = true; this.socket.end(); this.onclose(code);
  }
}
