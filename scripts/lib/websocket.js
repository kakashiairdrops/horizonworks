'use strict';

/**
 * A minimal RFC 6455 WebSocket client over a raw TCP socket.
 *
 * Why not the global `WebSocket`? Node's built-in client negotiates
 * permessage-deflate and then drops the Chrome DevTools connection with close
 * code 1006 as soon as a session-scoped frame arrives. This client offers no
 * extensions, so every frame stays uncompressed and the connection survives.
 *
 * Scope is deliberately narrow: client-to-server text frames, continuation
 * frames, ping/pong, and close. That is all CDP needs.
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Emits 'open', 'message' (string), 'close' (code, reason), and 'error'. */
class RawWebSocket extends EventEmitter {
  constructor(url) {
    super();
    const parsed = new URL(url);
    this.url = url;
    this.open = false;
    this.closed = false;

    // Frames arrive split across TCP reads; both buffers accumulate until complete.
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;

    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64');

    this.socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port || 80),
      noDelay: true
    }, () => {
      const request = [
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n');
      this.socket.write(request);
    });

    this.socket.setMaxListeners(0);
    this.socket.on('error', (error) => {
      if (!this.closed) this.emit('error', error);
    });
    this.socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', 1006, 'socket closed');
      }
    });

    let handshakeDone = false;
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);

      if (!handshakeDone) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = this.buffer.subarray(0, end).toString('latin1');
        this.buffer = this.buffer.subarray(end + 4);

        const statusLine = head.split('\r\n')[0];
        if (!/^HTTP\/1\.1 101/.test(statusLine)) {
          this.emit('error', new Error(`WebSocket upgrade rejected: ${statusLine}`));
          this.destroy();
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        if (accept !== expectedAccept) {
          this.emit('error', new Error('WebSocket handshake key mismatch'));
          this.destroy();
          return;
        }
        handshakeDone = true;
        this.open = true;
        this.emit('open');
      }

      this.drainFrames();
    });
  }

  /** Pulls every complete frame out of the read buffer. */
  drainFrames() {
    for (;;) {
      if (this.buffer.length < 2) return;

      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.emit('error', new Error('WebSocket frame too large'));
          this.destroy();
          return;
        }
        length = Number(big);
        offset += 8;
      }

      // A server must not mask, but handle it rather than corrupting the stream.
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);

      this.handleFrame({ fin, opcode, payload });
      if (this.closed) return;
    }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODE.PING) {
      this.writeFrame(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.PONG) return;

    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (!this.closed) {
        this.closed = true;
        this.writeFrame(OPCODE.CLOSE, payload);
        this.emit('close', code, reason);
      }
      this.destroy();
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }

    if (!fin) return;

    const complete = Buffer.concat(this.fragments);
    this.fragments = [];
    const finishedOpcode = this.fragmentOpcode;
    this.fragmentOpcode = null;

    if (finishedOpcode === OPCODE.TEXT) this.emit('message', complete.toString('utf8'));
    else if (finishedOpcode === OPCODE.BINARY) this.emit('message', complete);
  }

  writeFrame(opcode, payload) {
    if (this.socket.destroyed) return;

    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = crypto.randomBytes(4);

    let header;
    if (body.length < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | body.length;
      mask.copy(header, 2);
    } else if (body.length < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
      mask.copy(header, 10);
    }
    header[0] = 0x80 | opcode;

    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];

    this.socket.write(Buffer.concat([header, masked]));
  }

  send(text) {
    if (!this.open) throw new Error('WebSocket is not open');
    this.writeFrame(OPCODE.TEXT, text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    this.writeFrame(OPCODE.CLOSE, payload);
    setTimeout(() => this.destroy(), 50);
  }

  destroy() {
    this.open = false;
    this.socket.destroy();
  }

  /** Resolves once the handshake completes, rejects on failure or timeout. */
  waitForOpen(timeoutMs = 10000) {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), timeoutMs);
      this.once('open', () => { clearTimeout(timer); resolve(); });
      this.once('error', (error) => { clearTimeout(timer); reject(error); });
      this.once('close', () => { clearTimeout(timer); reject(new Error('WebSocket closed before opening')); });
    });
  }
}

module.exports = { RawWebSocket };
