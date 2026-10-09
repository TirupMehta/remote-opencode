// Authenticated JSON API + SSE stream + static PWA shell for OpenCode Remote.
// Same-origin only (no CORS headers are ever emitted). Mutations require a
// double-submit CSRF token. All OpenCode interactions go through the verified
// client in opencode.ts; nothing here invents capabilities.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Auth, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, cookieHeader, parseCookies } from './auth.ts';
import type { AppConfig } from './config.ts';
import { saveConfig } from './config.ts';
import { OpenCode } from './opencode.ts';
import { Relay, extractPreview } from './relay.ts';
import { Store } from './store.ts';
import { getTailscaleIPv4, tailscaleInstalled } from './tailscale.ts';
import type { SessionView } from './types.ts';
import {
  HttpError,
  asId,
  asOptionalString,
  asString,
  badRequest,
  dirExists,
  forbidden,
  normalizeDir,
  notFound,
  requireAllowlistedDir,
  unauthorized,
  withinAllowlist,
} from './validate.ts';

const BODY_LIMIT = 1_000_000;

export interface ApiContext {
  config: AppConfig;
  secretsPath: string;
  auth: Auth;
  oc: OpenCode;
  relay: Relay;
  store: Store;
  webRoot: string;
  saveSettings: () => void;
  /** Effective listen address (may be the auto-detected Tailnet IP). */
  listenHost?: string;
  /** App version shown in Status (from package.json). */
  appVersion: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendErr(res: ServerResponse, e: unknown): void {
  if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
  const err = e as { status?: number; message?: string };
  if (typeof err?.status === 'number') return sendJson(res, err.status, { error: { code: 'error', message: err.message || 'Request failed' } });
  // Never leak stack traces or secrets to clients; log server-side instead.
  console.error('[api]', (e as Error)?.message || e);
  return sendJson(res, 500, { error: { code: 'internal', message: 'Internal error' } });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(badRequest('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Simple per-IP login throttle (in-memory).
const loginAttempts = new Map<string, number[]>();
function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  loginAttempts.set(ip, arr);
  return arr.length <= 8;
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ctx.webRoot, rel));
  if (!file.startsWith(ctx.webRoot)) {
    sendJson(res, 403, { error: { code: 'forbidden', message: 'Invalid path' } });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (rel.startsWith('/api/')) return sendErr(res, notFound('Unknown API route'));
      // SPA fallback for app routes.
      fs.readFile(path.join(ctx.webRoot, 'index.html'), (e2, d2) => {
        if (e2) return sendJson(res, 500, { error: { code: 'internal', message: 'UI not built' } });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': STATIC_TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || rel.endsWith('sw.js') ? 'no-cache' : 'public, max-age=86400',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; script-src 'self'; worker-src 'self'",
    };
    res.writeHead(200, headers);
    res.end(data);
  });
}

export async function handleRequest(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  if (!p.startsWith('/api/')) {
    if (method !== 'GET') return sendErr(res, notFound('Not found'));
    return serveStatic(ctx, req, res, p);
  }

  const cookies = parseCookies(req.headers.cookie);
  const session = ctx.auth.verify(cookies[SESSION_COOKIE]);

  // ---- public auth endpoints ----
  if (p === '/api/auth/status' && method === 'GET') {
    return sendJson(res, 200, { setupRequired: ctx.auth.setupRequired, authenticated: !!session });
  }
  if (p === '/api/auth/setup' && method === 'POST') {
    if (!ctx.auth.setupRequired) return sendErr(res, forbidden('Setup is already complete'));
    if (!isLoopback(req)) return sendErr(res, forbidden('Initial setup is only allowed from the laptop itself'));
    const body = (await readBody(req).catch((e) => sendErr(res, e))) as { password?: string } | undefined;
    if (!body || res.writableEnded) return;
    try {
      ctx.auth.setInitialPassword(asString(body.password, 'password', 200));
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendErr(res, e);
    }
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!loginAllowed(ip)) return sendJson(res, 429, { error: { code: 'rate_limited', message: 'Too many attempts, wait a minute' } });
    const body = (await readBody(req).catch((e) => sendErr(res, e))) as { password?: string } | undefined;
    if (!body || res.writableEnded) return;
    if (typeof body.password !== 'string') return sendErr(res, badRequest('password must be a string'));
    // Small uniform delay to blunt online guessing.
    await new Promise((r) => setTimeout(r, 400));
    const s = ctx.auth.login(body.password);
    if (!s) return sendErr(res, unauthorized('Incorrect password'));
    res.setHeader('set-cookie', [
      cookieHeader(SESSION_COOKIE, s.sid, { maxAge: 30 * 24 * 3600 }),
      `ocr_csrf=${encodeURIComponent(s.csrf)}; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`,
    ]);
    return sendJson(res, 200, { ok: true });
  }

  // ---- everything below requires auth ----
  if (!session) return sendErr(res, unauthorized());
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (mutating && p !== '/api/auth/logout') {
    if (!ctx.auth.verifyCsrf(session, req.headers[CSRF_HEADER], cookies[CSRF_COOKIE])) {
      return sendErr(res, forbidden('Invalid CSRF token'));
    }
  }

  try {
    // auth
    if (p === '/api/auth/logout' && method === 'POST') {
      ctx.auth.logout(cookies[SESSION_COOKIE]);
      res.setHeader('set-cookie', [cookieHeader(SESSION_COOKIE, '', { clear: true }), `ocr_csrf=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`]);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/auth/change-password' && method === 'POST') {
      const body = (await readBody(req)) as { current?: string; next?: string };
      ctx.auth.changePassword(asString(body?.current, 'current', 200), asString(body?.next, 'next', 200));
      return sendJson(res, 200, { ok: true });
    }

    // stream
    if (p === '/api/stream' && method === 'GET') {
      return handleStream(ctx, req, res, url);
    }

    // watch: tell the backend a conversation is open so foreign writes
    // surface within ~2s instead of waiting for the discovery poll.
    if (p === '/api/watch' && method === 'POST') {
      const body = (await readBody(req)) as { sessionID?: string; release?: boolean; lastMsgId?: string };
      const sid = asId(body?.sessionID, 'session', 'ses');
      if (!ctx.relay.getCached(sid)) throw notFound('Session not found (it may have been deleted)');
      if (body?.release) ctx.relay.unwatch(sid);
      else {
        const lastMsgId = asOptionalString(body?.lastMsgId, 'lastMsgId', 100);
        if (lastMsgId !== undefined && !/^msg_[A-Za-z0-9]+$/.test(lastMsgId)) throw badRequest('Invalid lastMsgId');
        ctx.relay.watch(sid, lastMsgId || '');
      }
      return sendJson(res, 200, { ok: true });
    }

    // sessions
    if (p === '/api/sessions' && method === 'GET') {
      // First paint after boot: make sure at least one discovery pass ran.
      if (ctx.relay.getLastSync() === 0) {
        await ctx.relay.reconcile('demand').catch(() => undefined);
      }
      return sendJson(res, 200, { sessions: filterSessions(ctx, url), lastSync: ctx.relay.getLastSync() });
    }
    if (p === '/api/sessions' && method === 'POST') {
      // NOTE: await (not bare return) so rejections stay inside this try/catch.
      return await createSession(ctx, req, res);
    }
    const mSession = p.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (mSession) {
      return await handleSessionRoute(ctx, req, res, url, decodeURIComponent(mSession[1]), mSession[2] || '');
    }

    // projects / models / agents
    if (p === '/api/projects' && method === 'GET') {
      const discovered = await ctx.oc.listProjects().catch(() => []);
      const snap = ctx.relay.snapshot();
      const counts = new Map<string, number>();
      for (const s of snap) counts.set(s.projectID || '', (counts.get(s.projectID || '') || 0) + 1);
      return sendJson(res, 200, {
        allowlist: ctx.config.projects.map((d) => ({ directory: d, exists: dirExists(d) })),
        discovered: discovered.map((d) => ({ id: d.id, worktree: d.worktree, name: d.name || null, sessions: counts.get(d.id) || 0 })),
      });
    }
    if (p === '/api/models' && method === 'GET') {
      const [models, agents] = await Promise.all([
        ctx.oc.listModels().catch(() => []),
        ctx.oc.listAgents().catch(() => []),
      ]);
      return sendJson(res, 200, { models, agents, defaultModel: ctx.config.defaultModel || null, defaultAgent: ctx.config.defaultAgent || null });
    }

    // ptys
    if (p === '/api/ptys' && method === 'GET') {
      const out: Array<Record<string, unknown> & { directory: string }> = [];
      for (const d of ctx.config.projects) {
        try {
          const list = await ctx.oc.ptyList(normalizeDir(d));
          for (const t of list) out.push({ ...t, directory: normalizeDir(d) });
        } catch {
          /* a directory with no live instance simply contributes nothing */
        }
      }
      return sendJson(res, 200, { ptys: out });
    }
    if (p === '/api/ptys' && method === 'POST') {
      const body = (await readBody(req)) as { directory?: string; command?: string; args?: string[]; title?: string };
      const dir = requireAllowlistedDir(asString(body?.directory, 'directory', 1000), ctx.config.projects, 'Terminal');
      const title = asOptionalString(body?.title, 'title', 120);
      const command = asOptionalString(body?.command, 'command', 500);
      let args: string[] | undefined;
      if (body?.args !== undefined) {
        if (!Array.isArray(body.args) || body.args.length > 20 || body.args.some((x) => typeof x !== 'string' || x.length > 500)) {
          throw badRequest('args must be an array of up to 20 short strings');
        }
        args = body.args as string[];
      }
      const info = await ctx.oc.ptyCreate(dir, {
        command: command || (process.platform === 'win32' ? 'powershell.exe' : undefined),
        args,
        cwd: dir,
        title: title || `Phone terminal`,
      });
      return sendJson(res, 201, { pty: { ...info, directory: dir } });
    }
    const mPty = p.match(/^\/api\/ptys\/([^/]+)$/);
    if (mPty) {
      const ptyID = asId(decodeURIComponent(mPty[1]), 'pty', 'pty');
      if (method === 'PUT') {
        const body = (await readBody(req)) as { directory?: string; title?: string; size?: { rows: number; cols: number } };
        const dir = requireAllowlistedDir(asString(body?.directory, 'directory', 1000), ctx.config.projects, 'Terminal');
        const patch: { title?: string; size?: { rows: number; cols: number } } = {};
        const title = asOptionalString(body?.title, 'title', 120);
        if (title) patch.title = title;
        if (body?.size) {
          const { rows, cols } = body.size as { rows: number; cols: number };
          if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 5 || cols < 20 || rows > 300 || cols > 500) {
            throw badRequest('Invalid terminal size');
          }
          patch.size = { rows, cols };
        }
        if (!patch.title && !patch.size) throw badRequest('Nothing to update');
        const info = await ctx.oc.ptyUpdate(ptyID, dir, patch);
        return sendJson(res, 200, { pty: { ...info, directory: dir } });
      }
      if (method === 'DELETE') {
        const dir = requireAllowlistedDir(asOptionalString(url.searchParams.get('directory'), 'directory', 1000) || '', ctx.config.projects, 'Terminal');
        await ctx.oc.ptyDelete(ptyID, dir);
        return sendJson(res, 200, { ok: true });
      }
    }

    // questions (approvals surfaced as questions)
    const mQ = p.match(/^\/api\/questions\/([^/]+)\/(reply|reject)$/);
    if (mQ && method === 'POST') {
      const qid = asString(decodeURIComponent(mQ[1]), 'question', 100);
      if (mQ[2] === 'reject') {
        await ctx.oc.rejectQuestion(qid);
        return sendJson(res, 200, { ok: true });
      }
      const body = (await readBody(req)) as { answers?: string[][] };
      if (!Array.isArray(body?.answers)) throw badRequest('answers must be an array of arrays of labels');
      await ctx.oc.replyQuestion(qid, body.answers);
      return sendJson(res, 200, { ok: true });
    }

    // settings
    if (p === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, {
        projects: ctx.config.projects,
        defaultModel: ctx.config.defaultModel || null,
        defaultAgent: ctx.config.defaultAgent || null,
        pollSeconds: ctx.config.pollSeconds,
        port: ctx.config.port,
        host: ctx.config.host,
        passwordSetAt: ctx.config.passwordSetAt || null,
      });
    }
    if (p === '/api/settings' && method === 'PUT') {
      const body = (await readBody(req)) as { projects?: string[]; defaultModel?: { providerID: string; id: string } | null; defaultAgent?: string | null; pollSeconds?: number };
      if (body?.projects !== undefined) {
        if (!Array.isArray(body.projects) || body.projects.length > 50) throw badRequest('projects must be an array of up to 50 directories');
        const clean: string[] = [];
        for (const d of body.projects) {
          if (typeof d !== 'string') throw badRequest('projects must be strings');
          const norm = normalizeDir(d);
          if (!dirExists(norm)) throw badRequest(`Directory does not exist: ${d}`);
          if (!clean.includes(norm)) clean.push(norm);
        }
        if (!clean.length) throw badRequest('At least one project directory is required');
        ctx.config.projects = clean;
      }
      if (body?.defaultModel !== undefined) {
        if (body.defaultModel === null) delete ctx.config.defaultModel;
        else {
          ctx.config.defaultModel = {
            providerID: asString(body.defaultModel.providerID, 'defaultModel.providerID', 100),
            id: asString(body.defaultModel.id, 'defaultModel.id', 200),
          };
        }
      }
      if (body?.defaultAgent !== undefined) {
        ctx.config.defaultAgent = asOptionalString(body.defaultAgent, 'defaultAgent', 100);
      }
      if (body?.pollSeconds !== undefined) {
        const n = Number(body.pollSeconds);
        if (!Number.isInteger(n) || n < 5 || n > 300) throw badRequest('pollSeconds must be 5..300');
        ctx.config.pollSeconds = n;
      }
      ctx.saveSettings();
      ctx.relay.resubscribe();
      void ctx.relay.reconcile('settings');
      return sendJson(res, 200, { ok: true });
    }

    // health + connection
    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ...(await ctx.relay.health()), uptime: process.uptime(), app: ctx.appVersion });
    }
    if (p === '/api/connection' && method === 'GET') {
      return sendJson(res, 200, await connectionInfo(ctx));
    }

    return sendErr(res, notFound('Unknown API route'));
  } catch (e) {
    return sendErr(res, e);
  }
}

function filterSessions(ctx: ApiContext, url: URL): SessionView[] {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const project = url.searchParams.get('project') || '';
  const view = url.searchParams.get('view') || 'all'; // all | active | hidden
  let list = ctx.relay.snapshot();
  if (view === 'active') list = list.filter((s) => !s.hidden && (s.state === 'running' || s.state === 'active-external' || s.state === 'attention'));
  else if (view === 'hidden') list = list.filter((s) => s.hidden);
  else list = list.filter((s) => !s.hidden);
  if (project) list = list.filter((s) => s.projectID === project || s.projectName === project);
  if (q) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q),
    );
  }
  return list;
}

async function createSession(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as {
    directory?: string;
    title?: string;
    agent?: string;
    model?: { providerID: string; id: string };
    prompt?: string;
    idempotencyKey?: string;
  };
  const dir = requireAllowlistedDir(asString(body?.directory, 'directory', 1000), ctx.config.projects, 'Project');
  const key = asOptionalString(body?.idempotencyKey, 'idempotencyKey', 100);
  if (key && ctx.store.seenKey('create:' + key)) {
    // Retry of an already-accepted creation: point the phone at the newest
    // session instead of duplicating it.
    const snap = ctx.relay.snapshot().filter((s) => s.directory === dir);
    return sendJson(res, 200, { session: snap[0] || null, duplicate: true });
  }
  const title = asOptionalString(body?.title, 'title', 200);
  const agent = asOptionalString(body?.agent, 'agent', 100) || ctx.config.defaultAgent;
  let model: { providerID: string; id: string } | undefined;
  if (body?.model) {
    model = { providerID: asString(body.model.providerID, 'model.providerID', 100), id: asString(body.model.id, 'model.id', 200) };
  } else if (ctx.config.defaultModel) {
    model = ctx.config.defaultModel;
  }
  const created = await ctx.oc.createSession(dir, { title, agent, model });
  await ctx.relay.reconcile('create');
  const prompt = asOptionalString(body?.prompt, 'prompt', 20000);
  if (prompt) {
    await ctx.oc.promptAsync(created.id, dir, {
      ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
      ...(agent ? { agent } : {}),
      parts: [{ type: 'text', text: prompt }],
    });
  }
  const view = ctx.relay.snapshot().find((s) => s.id === created.id) || null;
  return sendJson(res, 201, { session: view || created, promptSent: !!prompt });
}

async function handleSessionRoute(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  id: string,
  rest: string,
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const sessionID = asId(id, 'session', 'ses');

  if (rest === '' && method === 'GET') {
    const cached = ctx.relay.getCached(sessionID);
    if (!cached) throw notFound('Session not found (it may have been deleted)');
    const view = ctx.relay.snapshot().find((s) => s.id === sessionID) || null;
    return sendJson(res, 200, { session: view });
  }
  if (rest === '/messages' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 200);
    const cached = ctx.relay.getCached(sessionID);
    if (!cached) throw notFound('Session not found (it may have been deleted)');
    const msgs = await ctx.oc.listMessages(sessionID, limit);
    const last = msgs[msgs.length - 1];
    if (last) {
      const c = ctx.relay.getCached(sessionID);
      if (c) {
        c.lastMsgAt = Date.now();
        c.preview = extractPreview(msgs as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>);
      }
    }
    return sendJson(res, 200, { messages: msgs });
  }
  if (rest === '/messages' && method === 'POST') {
    const body = (await readBody(req)) as { text?: string; model?: { providerID: string; id: string }; agent?: string; idempotencyKey?: string };
    const text = asString(body?.text, 'text', 20000);
    const cached = ctx.relay.getCached(sessionID);
    if (!cached) throw notFound('Session not found (it may have been deleted)');
    const dir = normalizeDir(cached.session.directory);
    if (!withinAllowlist(dir, ctx.config.projects)) throw forbidden('This session is outside the allowed projects (read-only)');
    const key = asOptionalString(body?.idempotencyKey, 'idempotencyKey', 100);
    if (key && ctx.store.seenKey(`msg:${sessionID}:${key}`)) {
      return sendJson(res, 200, { accepted: true, duplicate: true });
    }
    let model: { providerID: string; id: string } | undefined;
    if (body?.model) {
      model = { providerID: asString(body.model.providerID, 'model.providerID', 100), id: asString(body.model.id, 'model.id', 200) };
    } else if (cached.session.model) {
      // Keep the session's own model — never silently switch.
      model = { providerID: cached.session.model.providerID, id: cached.session.model.id };
    } else if (ctx.config.defaultModel) {
      model = ctx.config.defaultModel;
    }
    const agent = asOptionalString(body?.agent, 'agent', 100);
    await ctx.oc.promptAsync(sessionID, dir, {
      ...(model ? { model: { providerID: model.providerID, modelID: model.id } } : {}),
      ...(agent ? { agent } : {}),
      parts: [{ type: 'text', text }],
    });
    return sendJson(res, 202, { accepted: true });
  }
  if (rest === '/abort' && method === 'POST') {
    const cached = ctx.relay.getCached(sessionID);
    if (!cached) throw notFound('Session not found (it may have been deleted)');
    const dir = normalizeDir(cached.session.directory);
    if (!withinAllowlist(dir, ctx.config.projects)) throw forbidden('This session is outside the allowed projects (read-only)');
    const ok = await ctx.oc.abort(sessionID, dir);
    return sendJson(res, 200, { ok });
  }
  if (rest === '' && method === 'PATCH') {
    const body = (await readBody(req)) as { title?: string };
    const updated = await ctx.oc.updateSession(sessionID, { title: asString(body?.title, 'title', 200) });
    await ctx.relay.reconcile('rename');
    return sendJson(res, 200, { session: updated });
  }
  if (rest === '/hide' && method === 'POST') {
    const body = (await readBody(req)) as { hidden?: boolean };
    const hidden = body?.hidden !== false;
    const cached = ctx.relay.getCached(sessionID);
    if (!cached && hidden) throw notFound('Session not found (it may have been deleted)');
    ctx.store.setHidden(sessionID, hidden);
    ctx.relay.emit('sessions', { sessions: ctx.relay.snapshot(), reason: hidden ? 'hide' : 'unhide' });
    return sendJson(res, 200, { ok: true, hidden });
  }
  if (rest === '' && method === 'DELETE') {
    // Close (hide) by default — history is never deleted implicitly.
    const body = ((await readBody(req).catch(() => undefined)) || {}) as { deleteHistory?: boolean; confirm?: boolean };
    const cached = ctx.relay.getCached(sessionID);
    if (body.deleteHistory) {
      if (!cached) throw notFound('Session not found (it may have been deleted)');
      const dir = normalizeDir(cached.session.directory);
      if (!withinAllowlist(dir, ctx.config.projects)) throw forbidden('Deleting sessions outside the allowed projects is not permitted');
      if (body.confirm !== true) throw badRequest('Deleting history requires { deleteHistory: true, confirm: true }');
      await ctx.oc.deleteSession(sessionID);
      ctx.store.setHidden(sessionID, false);
      await ctx.relay.reconcile('delete');
      return sendJson(res, 200, { ok: true, deleted: true });
    }
    ctx.store.setHidden(sessionID, true);
    ctx.relay.emit('sessions', { sessions: ctx.relay.snapshot(), reason: 'close' });
    return sendJson(res, 200, { ok: true, hidden: true });
  }
  const mPerm = rest.match(/^\/permissions\/([^/]+)$/);
  if (mPerm && method === 'POST') {
    const body = (await readBody(req)) as { response?: string };
    const r = body?.response;
    if (r !== 'once' && r !== 'always' && r !== 'reject') throw badRequest('response must be once, always or reject');
    const cached = ctx.relay.getCached(sessionID);
    if (!cached) throw notFound('Session not found (it may have been deleted)');
    if (!withinAllowlist(normalizeDir(cached.session.directory), ctx.config.projects)) throw forbidden('This session is outside the allowed projects (read-only)');
    const ok = await ctx.oc.replyPermission(sessionID, asString(decodeURIComponent(mPerm[1]), 'permission', 100), r);
    return sendJson(res, 200, { ok });
  }
  return sendErr(res, notFound('Unknown API route'));
}

function handleStream(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const lastId = Number(url.searchParams.get('lastId')) || 0;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (id: number, type: string, data: unknown, sessionID?: string): void => {
    res.write(`id: ${id}\ndata: ${JSON.stringify({ id, type, sessionID, data })}\n\n`);
  };
  // Catch up on anything missed while offline, then send a full snapshot.
  // The snapshot carries the current latest ID so resume continues after it.
  for (const ev of ctx.relay.eventsAfter(lastId)) {
    send(ev.id, ev.type, ev.data, ev.sessionID);
  }
  send(ctx.relay.latestId(), 'sync', {
    at: Date.now(),
    sessions: ctx.relay.snapshot(),
    resumed: lastId > 0,
  });
  const off = ctx.relay.onEvent((ev) => {
    try {
      send(ev.id, ev.type, ev.data, ev.sessionID);
    } catch {
      /* client gone */
    }
  });
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);
  beat.unref?.();
  req.on('close', () => {
    clearInterval(beat);
    off();
  });
}

async function connectionInfo(ctx: ApiContext): Promise<Record<string, unknown>> {
  const os = await import('node:os');
  const nets: string[] = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) nets.push(a.address);
      }
    }
  } catch {
    /* ignore */
  }
  const tip = await getTailscaleIPv4();
  // Distinguish "installed but logged out" (actionable: sign in once) from
  // "not installed" so the Status tab can guide correctly.
  const tailscale: { installed: boolean; ip?: string } = tip
    ? { installed: true, ip: tip }
    : { installed: tailscaleInstalled() };
  const health = await ctx.relay.health();
  const port = ctx.config.port;
  const host = ctx.listenHost || ctx.config.host;
  const local = `http://127.0.0.1:${port}`;
  return {
    host,
    port,
    localUrl: local,
    lanUrls: nets.map((ip) => `http://${ip}:${port}`),
    tailscaleUrl: tailscale.ip ? `http://${tailscale.ip}:${port}` : null,
    tailscale,
    lastSync: ctx.relay.getLastSync(),
    synced: ctx.relay.isFullOk(),
    opencode: health.opencode,
  };
}
