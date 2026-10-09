// Live integration test: boots the REAL stack (managed `opencode serve` +
// sync engine + HTTP API) in temp dirs and exercises the whole remote API.
// Run: OCR_TEST_LIVE=1 npm run test:integration
// Uses one tiny AI prompt (a few words) and cleans up everything it creates.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Auth } from '../src/auth.ts';
import type { AppConfig } from '../src/config.ts';
import { OpenCode } from '../src/opencode.ts';
import { Relay } from '../src/relay.ts';
import { Store } from '../src/store.ts';
import { handleRequest, type ApiContext } from '../src/api.ts';
import { handleTerminalUpgrade } from '../src/main.ts';

const LIVE = process.env.OCR_TEST_LIVE === '1';

interface Ctx {
  base: string;
  ctx: ApiContext;
  oc: OpenCode;
  relay: Relay;
  server: http.Server;
  projA: string;
  projB: string;
  sid: string;
  csrf: string;
}

let T: Ctx;
const RUN = Date.now().toString(36);
const TITLE_SESSION = `it-session-${RUN}`;
const TITLE_DIRECT = `it-laptop-direct-${RUN}`;
const TITLE_B = `it-b-${RUN}`;

async function req(method: string, p: string, opts: { body?: unknown; auth?: boolean; csrf?: boolean; timeout?: number } = {}): Promise<{ status: number; json: unknown; headers: http.IncomingHttpHeaders }> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false && T.sid) headers.cookie = `ocr_sid=${T.sid}; ocr_csrf=${T.csrf}`;
  if (opts.csrf !== false && T.csrf && method !== 'GET') headers['x-csrf-token'] = T.csrf;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${method} ${p}`)), opts.timeout ?? 30000);
  try {
    const res = await fetch(T.base + p, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers as unknown as http.IncomingHttpHeaders };
  } finally {
    clearTimeout(timer);
  }
}

describe('live integration', { skip: !LIVE }, () => {
  before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-it-data-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-it-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-it-b-'));
    const webRoot = path.resolve('web');
    const config: AppConfig = { port: 0, host: '127.0.0.1', dataDir, projects: [projA], pollSeconds: 5 };
    const store = new Store(dataDir);
    const auth = new Auth(config, () => {});
    auth.setInitialPassword('integration-test-pw-99');
    const oc = new OpenCode();
    await oc.start();
    const relay = new Relay(oc, config, store);
    const ctx: ApiContext = { config, secretsPath: path.join(dataDir, 'config.json'), auth, oc, relay, store, webRoot, saveSettings: () => {}, appVersion: 'test' };
    relay.start();
    const server = http.createServer((rq, rs) => void handleRequest(ctx, rq, rs).catch(() => undefined));
    server.on('upgrade', (rq, sock) => void handleTerminalUpgrade(ctx, rq, sock as unknown as net.Socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    T = { base: `http://127.0.0.1:${port}`, ctx, oc, relay, server, projA, projB, sid: '', csrf: '' };
    await relay.reconcile('test-boot');
  });

  after(async () => {
    // Remove anything this run created from the shared OpenCode DB.
    try {
      const all = await T?.oc.listSessions();
      for (const s of all || []) {
        if (s.title === TITLE_SESSION || s.title === TITLE_DIRECT || s.title === TITLE_B || s.title === `it-renamed-${RUN}`) {
          await T.oc.deleteSession(s.id).catch(() => undefined);
        }
      }
    } catch {}
    T?.relay.stop();
    if (T) {
      // Drop every socket (undici keep-alive + open SSE) so the server can close.
      try {
        T.server.closeAllConnections();
      } catch {}
      await new Promise<void>((resolve) => T.server.close(() => resolve()));
    }
    await T?.oc.stop();
  });

  it('rejects unauthenticated API access', async () => {
    const r = await req('GET', '/api/sessions', { auth: false });
    assert.equal(r.status, 401);
  });

  it('logs in (wrong password fails, right succeeds)', async () => {
    const bad = await req('POST', '/api/auth/login', { auth: false, csrf: false, body: { password: 'nope-nope-nope' } });
    assert.equal(bad.status, 401);
    // login via raw fetch to capture cookies
    const res = await fetch(T.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'integration-test-pw-99' }),
    });
    assert.equal(res.status, 200);
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const sid = /ocr_sid=([^;]+)/.exec(setCookies.join(';'))?.[1];
    const csrf = /ocr_csrf=([^;]+)/.exec(setCookies.join(';'))?.[1];
    assert.ok(sid && csrf);
    T.sid = decodeURIComponent(sid);
    T.csrf = decodeURIComponent(csrf);
  });

  it('requires CSRF for mutations', async () => {
    const r = await req('POST', '/api/sessions', { csrf: false, body: {} });
    assert.equal(r.status, 403);
  });

  let sessionId = '';
  const createKey = 'it-create-1';

  it('creates a session in the allowlisted project (idempotent)', async () => {
    const r = await req('POST', '/api/sessions', { body: { directory: T.projA, title: TITLE_SESSION, idempotencyKey: createKey, prompt: 'Reply with exactly: E2E-OK and nothing else.' } });
    assert.equal(r.status, 201);
    sessionId = (r.json as { session: { id: string } }).session.id;
    assert.match(sessionId, /^ses_/);
    const dup = await req('POST', '/api/sessions', { body: { directory: T.projA, title: TITLE_SESSION, idempotencyKey: createKey } });
    assert.equal(dup.status, 200);
    assert.equal((dup.json as { duplicate: boolean }).duplicate, true);
    const list = (await req('GET', '/api/sessions?view=all')).json as { sessions: Array<{ id: string; title: string }> };
    assert.equal(list.sessions.filter((s) => s.title === TITLE_SESSION).length, 1);
  });

  it('refuses creation outside the allowlist', async () => {
    const r = await req('POST', '/api/sessions', { body: { directory: T.projB } });
    assert.equal(r.status, 403);
  });

  it('discovers a session created directly via OpenCode (laptop CLI path)', async () => {
    const created = await T.oc.createSession(T.projA, { title: TITLE_DIRECT });
    await T.relay.reconcile('test-discover');
    const list = (await req('GET', '/api/sessions?view=all')).json as { sessions: Array<{ id: string }> };
    assert.ok(list.sessions.some((s) => s.id === created.id), 'direct session visible via API');
    await T.oc.deleteSession(created.id);
  });

  it('AI reply arrives in the correct session (prompt -> poll -> verify)', async () => {
    let found = '';
    for (let i = 0; i < 75; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const msgs = (await req('GET', `/api/sessions/${sessionId}/messages?limit=10`)).json as {
        messages: Array<{ info: { role: string; time: { completed?: number } }; parts: Array<{ type: string; text?: string }> }>;
      };
      const done = msgs.messages.filter((m) => m.info.role === 'assistant' && m.info.time.completed);
      if (done.length) {
        found = done.map((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).join('\n');
        break;
      }
    }
    assert.match(found, /E2E-OK/);
  });

  it('message resend with the same idempotency key is a no-op', async () => {
    const key = 'it-msg-dup';
    const r1 = await req('POST', `/api/sessions/${sessionId}/messages`, { body: { text: 'Second prompt: reply EXACTLY with DUP-OK', idempotencyKey: key } });
    assert.equal(r1.status, 202);
    const r2 = await req('POST', `/api/sessions/${sessionId}/messages`, { body: { text: 'Second prompt: reply EXACTLY with DUP-OK', idempotencyKey: key } });
    assert.equal((r2.json as { duplicate: boolean }).duplicate, true);
    // wait for the one real reply
    let found = '';
    for (let i = 0; i < 75; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const msgs = (await req('GET', `/api/sessions/${sessionId}/messages?limit=10`)).json as {
        messages: Array<{ info: { role: string; time: { completed?: number } }; parts: Array<{ type: string; text?: string }> }>;
      };
      const texts = msgs.messages.filter((m) => m.info.role === 'assistant' && m.info.time.completed)
        .map((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).join('\n');
      if (/DUP-OK/.test(texts)) {
        found = texts;
        break;
      }
    }
    assert.match(found, /DUP-OK/);
  });

  it('abort on a settled session returns honestly', async () => {
    const r = await req('POST', `/api/sessions/${sessionId}/abort`, { body: {} });
    assert.equal(r.status, 200);
    assert.equal(typeof (r.json as { ok: boolean }).ok, 'boolean');
  });

  it('renames, archives without deleting, closes, then deletes with confirm', async () => {
    const rn = await req('PATCH', `/api/sessions/${sessionId}`, { body: { title: `it-renamed-${RUN}` } });
    assert.equal(rn.status, 200);
    const hide = await req('POST', `/api/sessions/${sessionId}/hide`, { body: { hidden: true } });
    assert.equal(hide.status, 200);
    const hidden = (await req('GET', '/api/sessions?view=hidden')).json as { sessions: Array<{ id: string; hidden: boolean }> };
    assert.equal(hidden.sessions.find((s) => s.id === sessionId)?.hidden, true);
    // history intact while hidden
    const msgs = await req('GET', `/api/sessions/${sessionId}/messages?limit=5`);
    assert.equal(msgs.status, 200);
    await req('POST', `/api/sessions/${sessionId}/hide`, { body: { hidden: false } });
    const noConfirm = await req('DELETE', `/api/sessions/${sessionId}`, { body: { deleteHistory: true } });
    assert.equal(noConfirm.status, 400);
    const del = await req('DELETE', `/api/sessions/${sessionId}`, { body: { deleteHistory: true, confirm: true } });
    assert.equal(del.status, 200);
    await T.relay.reconcile('test-deleted');
    const after = (await req('GET', '/api/sessions?view=all')).json as { sessions: Array<{ id: string }> };
    assert.equal(after.sessions.some((s) => s.id === sessionId), false);
  });

  it('serves the event stream with a live snapshot', async () => {
    const ctrl = new AbortController();
    const res = await fetch(T.base + '/api/stream?lastId=0', {
      headers: { cookie: `ocr_sid=${T.sid}; ocr_csrf=${T.csrf}` },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body!.getReader();
    let buf = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !buf.includes('"type":"sync"')) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      if (buf.length > 200000) break;
    }
    try {
      await reader.cancel();
    } catch {}
    ctrl.abort();
    assert.match(buf, /"type":"sync"/);
  });

  it('PTY lifecycle: create, list, interactive WS, delete', async () => {
    const created = (await req('POST', '/api/ptys', { body: { directory: T.projA, title: 'it-pty' } }));
    assert.equal(created.status, 201);
    const pty = (created.json as { pty: { id: string } }).pty;
    const list = (await req('GET', '/api/ptys')).json as { ptys: Array<{ id: string }> };
    assert.ok(list.ptys.some((t) => t.id === pty.id));
    // raw-socket WS handshake (cookie auth) + masked input frame
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: Number(new URL(T.base).port) }, () => {
        sock.write(
          `GET /api/ptys/${pty.id}/connect?directory=${encodeURIComponent(T.projA)}&cursor=-1 HTTP/1.1\r\n` +
            `Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
            `Cookie: ocr_sid=${T.sid}; ocr_csrf=${T.csrf}\r\n\r\n`,
        );
      });
      let buf = Buffer.alloc(0);
      let upgraded = false;
      let got = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('pty ws timeout, got=' + JSON.stringify(got.slice(0, 200))));
      }, 20000);
      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const head = buf.toString('utf8');
          const i = head.indexOf('\r\n\r\n');
          if (i < 0) return;
          if (!head.startsWith('HTTP/1.1 101')) {
            clearTimeout(timer);
            reject(new Error('expected 101, got: ' + head.slice(0, 120)));
            return;
          }
          upgraded = true;
          buf = buf.subarray(i + 4);
          // masked text frame: echo WS-E2E
          const body = Buffer.from('echo WS-E2E\r', 'utf8');
          const frame = Buffer.alloc(2 + 4 + body.length);
          frame[0] = 0x81;
          frame[1] = 0x80 | body.length;
          frame.writeUInt32BE(0x01020304, 2);
          for (let k = 0; k < body.length; k++) frame[6 + k] = body[k] ^ [1, 2, 3, 4][k % 4];
          sock.write(frame);
        }
        // read server frames (unmasked)
        while (buf.length >= 2) {
          const len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            off = 4;
          }
          if (buf.length < off + (len === 126 ? buf.readUInt16BE(2) : len)) break;
          const L = len === 126 ? buf.readUInt16BE(2) : len;
          const op = buf[0] & 0x0f;
          const payload = buf.subarray(off, off + L);
          buf = buf.subarray(off + L);
          if (op === 0x1) got += payload.toString('utf8');
          if (got.includes('WS-E2E')) {
            clearTimeout(timer);
            sock.destroy();
            resolve();
            return;
          }
        }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const del = await req('DELETE', `/api/ptys/${pty.id}?directory=${encodeURIComponent(T.projA)}`);
    assert.equal(del.status, 200);
  });

  it('settings allowlist can be extended, then enforced', async () => {
    const put = await req('PUT', '/api/settings', { body: { projects: [T.projA, T.projB] } });
    assert.equal(put.status, 200);
    const now = await req('POST', '/api/sessions', { body: { directory: T.projB, title: TITLE_B } });
    assert.equal(now.status, 201);
    const bad = await req('PUT', '/api/settings', { body: { projects: ['C:\\does\\not\\exist\\xyz'] } });
    assert.equal(bad.status, 400);
    const createdId = (now.json as { session: { id: string } }).session.id;
    await T.oc.deleteSession(createdId);
  });
});
