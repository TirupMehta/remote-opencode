// Minimal WebSocket server (RFC 6455) for the phone<->backend terminal link,
// plus the proxy to OpenCode's native PTY socket. No dependencies: Node's
// http server hands us the Upgrade; we frame messages ourselves. Upstream we
// use the global WebSocket client.
//
// Downstream protocol (backend <-> phone):
//   text frame          terminal output (server->phone) or input (phone->server)
//   binary frame        upstream meta frame passthrough (0x00 + {"cursor": N})
//   text "\0{...}"      control envelope phone->server: {"resize":{rows,cols}}
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { OpenCode } from './opencode.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CTRL_PREFIX = '\0';

export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

interface Frame {
  opcode: number;
  payload: Uint8Array;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Encode a server->client frame (never masked). */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  let header: Uint8Array;
  if (len < 126) header = Uint8Array.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = new Uint8Array(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header[2] = (len >>> 8) & 0xff;
    header[3] = len & 0xff;
  } else {
    header = new Uint8Array(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    // lengths here are always < 2^32 in practice
    header[2] = 0; header[3] = 0; header[4] = 0; header[5] = 0;
    header[6] = (len >>> 24) & 0xff;
    header[7] = (len >>> 16) & 0xff;
    header[8] = (len >>> 8) & 0xff;
    header[9] = len & 0xff;
  }
  return concatBytes(header, payload);
}

/** Parse one client->server frame from buf. Returns null when incomplete. */
export function parseFrame(buf: Uint8Array): { frame: Frame; rest: Uint8Array } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = (buf[2] << 8) | buf[3];
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const view = new DataView(buf.buffer, buf.byteOffset + 2, 8);
    const big = view.getBigUint64(0);
    if (big > BigInt(16 * 1024 * 1024)) throw new Error('frame too large');
    len = Number(big);
    off = 10;
  }
  let mask: Uint8Array | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = buf.slice(off, off + len);
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { frame: { opcode, payload }, rest: buf.slice(off + len) };
}

export interface PtyProxyOptions {
  oc: OpenCode;
  ptyID: string;
  directory: string;
  cursor?: number;
  /** Value for the upstream Authorization header (our managed serve uses basic auth). */
  upstreamAuth: string;
  onResize: (rows: number, cols: number) => Promise<void>;
}

/** Bridge one phone socket to one OpenCode PTY socket. Resolves on close. */
export function proxyPty(socket: Socket, opts: PtyProxyOptions): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    let upstream: WebSocket | null = null;
    // Input that arrives before the upstream socket opens is queued (phones
    // send immediately after the 101 handshake) and flushed on open.
    const pending: Array<{ text: string } | { bin: Uint8Array }> = [];
    let pendingBytes = 0;
    const flushPending = (): void => {
      if (!upstream || upstream.readyState !== 1) return;
      for (const item of pending.splice(0)) {
        try {
          if ('text' in item) upstream.send(item.text);
          else upstream.send(item.bin.buffer.slice(item.bin.byteOffset, item.bin.byteOffset + item.bin.byteLength) as ArrayBuffer);
        } catch {
          /* ignore */
        }
      }
      pendingBytes = 0;
    };
    const sendUpstream = (item: { text: string } | { bin: Uint8Array }): void => {
      if (upstream && upstream.readyState === 1 && pending.length === 0) {
        try {
          if ('text' in item) upstream.send(item.text);
          else upstream.send(item.bin.buffer.slice(item.bin.byteOffset, item.bin.byteOffset + item.bin.byteLength) as ArrayBuffer);
          return;
        } catch {
          /* fall through to queue */
        }
      }
      const size = 'text' in item ? item.text.length : item.bin.length;
      if (pendingBytes + size < 65536 && pending.length < 100) {
        pending.push(item);
        pendingBytes += size;
      }
    };
    let buffer: Uint8Array = new Uint8Array(0);
    let pingTimer: NodeJS.Timeout | null = null;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const send = (opcode: number, payload: Uint8Array): void => {
      if (closed) return;
      try {
        socket.write(encodeFrame(opcode, payload));
      } catch {
        cleanup();
      }
    };
    const sendText = (opcode: number, text: string): void => send(opcode, enc.encode(text));
    const closeDown = (code = 1000): void => {
      if (closed) return;
      try {
        socket.write(encodeFrame(0x8, Uint8Array.from([(code >>> 8) & 0xff, code & 0xff])));
      } catch {
        /* ignore */
      }
      cleanup();
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      try {
        upstream?.close();
      } catch {
        /* ignore */
      }
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = concatBytes(buffer, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      for (;;) {
        let parsed: { frame: Frame; rest: Uint8Array } | null;
        try {
          parsed = parseFrame(buffer);
        } catch {
          closeDown(1009);
          return;
        }
        if (!parsed) return;
        buffer = parsed.rest;
        const { opcode, payload } = parsed.frame;
        if (opcode === 0x8) {
          // client close -> echo + cleanup
          send(0x8, payload);
          cleanup();
          return;
        } else if (opcode === 0x9) {
          send(0xa, payload); // pong
        } else if (opcode === 0xa) {
          /* pong — liveness only */
        } else if (opcode === 0x1) {
          const text = dec.decode(payload);
          if (text.startsWith(CTRL_PREFIX)) {
            try {
              const ctl = JSON.parse(text.slice(1)) as { resize?: { rows: number; cols: number } };
              if (ctl.resize && upstream && upstream.readyState === 1) {
                const { rows, cols } = ctl.resize;
                if (Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0 && rows < 300 && cols < 500) {
                  void opts.onResize(rows, cols).catch(() => undefined);
                }
              }
            } catch {
              /* malformed control — ignore */
            }
          } else {
            sendUpstream({ text });
          }
        } else if (opcode === 0x2) {
          sendUpstream({ bin: payload });
        }
      }
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    pingTimer = setInterval(() => send(0x9, new Uint8Array(0)), 25000);
    pingTimer.unref?.();

    // Connect upstream with basic auth (verified against the live server;
    // short-lived tickets proved flaky, so the direct authenticated upgrade
    // is preferred server-to-server on loopback).
    void (async () => {
      try {
        const params = new URLSearchParams({ directory: opts.directory });
        if (opts.cursor !== undefined) params.set('cursor', String(opts.cursor));
        const url = `${opts.oc.upstreamBase()}/pty/${opts.ptyID}/connect?${params.toString()}`;
        // Undici's WebSocket accepts a headers option at runtime; the bundled
        // lib.dom type only declares protocols, hence the narrow cast.
        const ws = new WebSocket(
          url,
          { headers: { authorization: opts.upstreamAuth } } as unknown as string[],
        );
        upstream = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          if (closed) {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            return;
          }
          flushPending();
        };
        ws.onmessage = (ev) => {
          if (closed) return;
          const data: unknown = ev.data;
          if (typeof data === 'string') sendText(0x1, data);
          else if (data instanceof ArrayBuffer) send(0x2, new Uint8Array(data));
          else if (typeof Blob !== 'undefined' && data instanceof Blob) {
            void (data as Blob).arrayBuffer().then(
              (ab) => send(0x2, new Uint8Array(ab)),
              () => undefined,
            );
          }
        };
        ws.onerror = () => {
          if (!closed) sendText(0x1, '\r\n[terminal upstream error]\r\n');
        };
        ws.onclose = () => closeDown(1000);
      } catch {
        if (!closed) {
          sendText(0x1, '\r\n[terminal unavailable: could not attach to PTY]\r\n');
          closeDown(1011);
        }
      }
    })();
  });
}
