// Manager for the `opencode serve` child process + typed client for the
// VERIFIED subset of its HTTP API (opencode 1.18.x). Every endpoint, flag,
// query parameter and body shape used here was confirmed against the live
// server (/doc OpenAPI + functional probes). Do not add endpoints without
// verifying them first — see AGENTS.md.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomToken } from './config.ts';
import type { OpenCodeSession, PtyInfo, SessionMessage } from './types.ts';
import { HttpError } from './validate.ts';

export interface UpstreamEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

interface ServeHandle {
  child: ChildProcess;
  port: number;
  password: string;
}

function findOpenCodeBin(): string {
  const envBin = process.env.OPENCODE_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const candidates: string[] = [];
  if (process.env.APPDATA) {
    candidates.push(
      path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(process.env.APPDATA, 'npm', 'opencode.exe'),
    );
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  // Fall back to PATH resolution.
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnServe(): Promise<ServeHandle> {
  const bin = findOpenCodeBin();
  const port = await freePort();
  const password = randomToken(24);
  const child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    detached: false,
  });
  return { child, port, password };
}

export class OpenCode {
  private serve: ServeHandle | null = null;
  private starting: Promise<void> | null = null;
  private dead = false;
  private version: string = 'unknown';
  private statusListeners = new Set<(healthy: boolean) => void>();
  private eventSubs = new Map<string, { stop: () => void }>();
  onEvent: ((dir: string, ev: UpstreamEvent) => void) | null = null;

  baseUrl(): string {
    if (!this.serve) throw new Error('opencode server not started');
    return `http://127.0.0.1:${this.serve.port}`;
  }

  isHealthy(): boolean {
    return !!this.serve && !this.dead;
  }

  getVersion(): string {
    return this.version;
  }

  onStatusChange(fn: (healthy: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setDead(): void {
    if (this.dead) return;
    this.dead = true;
    for (const fn of this.statusListeners) {
      try {
        fn(false);
      } catch {
        /* ignore */
      }
    }
  }

  async start(): Promise<void> {
    if (this.serve && !this.dead) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.serve = await spawnServe();
      this.dead = false;
      this.serve.child.on('exit', () => this.setDead());
      // Wait for health.
      const url = `${this.baseUrl()}/global/health`;
      let lastErr = '';
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(url, { headers: this.authHeaders() });
          if (r.ok) {
            const j = (await r.json()) as { version?: string };
            this.version = j.version || 'unknown';
            for (const fn of this.statusListeners) {
              try {
                fn(true);
              } catch {
                /* ignore */
              }
            }
            this.starting = null;
            return;
          }
          lastErr = `http ${r.status}`;
        } catch (e) {
          lastErr = String(e);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      this.starting = null;
      throw new Error(`opencode serve did not become ready (${lastErr})`);
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    for (const sub of this.eventSubs.values()) {
      try {
        sub.stop();
      } catch {
        /* ignore */
      }
    }
    this.eventSubs.clear();
    const child = this.serve?.child;
    this.serve = null;
    if (child && child.exitCode === null) {
      child.kill();
    }
  }

  private authHeaders(): Record<string, string> {
    if (!this.serve) return {};
    return { authorization: 'Basic ' + Buffer.from(`opencode:${this.serve.password}`).toString('base64') };
  }

  private dirQuery(directory: string): string {
    return `?directory=${encodeURIComponent(directory)}`;
  }

  private async req<T>(method: string, p: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = { ...this.authHeaders(), ...extraHeaders };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(this.baseUrl() + p, { method, headers, body: payload });
    } catch (e) {
      this.setDead();
      throw new HttpError(502, 'opencode_unreachable', `OpenCode server unreachable: ${(e as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; _tag?: string };
        msg = j.message || j._tag || msg;
      } catch {
        /* keep raw */
      }
      throw new HttpError(res.status >= 500 ? 502 : res.status, 'opencode_error', `OpenCode: ${msg}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ---- sessions (all verified live) ----
  listSessions(): Promise<OpenCodeSession[]> {
    return this.req('GET', '/session');
  }

  getSession(id: string): Promise<OpenCodeSession> {
    return this.req('GET', `/session/${id}`);
  }

  createSession(directory: string, body: { title?: string; agent?: string; model?: { providerID: string; id: string; variant?: string } }): Promise<OpenCodeSession> {
    return this.req('POST', `/session${this.dirQuery(directory)}`, body);
  }

  updateSession(id: string, body: { title?: string }): Promise<OpenCodeSession> {
    return this.req('PATCH', `/session/${id}`, body);
  }

  deleteSession(id: string): Promise<boolean> {
    return this.req('DELETE', `/session/${id}`);
  }

  listMessages(sessionID: string, limit = 100): Promise<SessionMessage[]> {
    return this.req('GET', `/session/${sessionID}/message?limit=${limit}`);
  }

  promptAsync(sessionID: string, directory: string, body: Record<string, unknown>): Promise<void> {
    return this.req('POST', `/session/${sessionID}/prompt_async${this.dirQuery(directory)}`, body);
  }

  abort(sessionID: string, directory: string): Promise<boolean> {
    return this.req('POST', `/session/${sessionID}/abort${this.dirQuery(directory)}`);
  }

  sessionStatus(directory: string): Promise<Record<string, { type: string }>> {
    return this.req('GET', `/session/status${this.dirQuery(directory)}`);
  }

  replyPermission(sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<boolean> {
    return this.req('POST', `/session/${sessionID}/permissions/${permissionID}`, { response });
  }

  replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    return this.req('POST', `/question/${requestID}/reply`, { answers });
  }

  rejectQuestion(requestID: string): Promise<boolean> {
    return this.req('POST', `/question/${requestID}/reject`);
  }

  // ---- projects / providers / agents (verified; providers redacted) ----
  listProjects(): Promise<Array<{ id: string; worktree: string; name?: string; time?: { created: number; updated: number } }>> {
    return this.req('GET', '/project');
  }

  async listModels(): Promise<Array<{ id: string; providerID: string; name: string; status?: string }>> {
    const j = await this.req<{ providers?: Array<{ id: string; name?: string; models?: Record<string, { id?: string; name?: string; status?: string }> }> }>('GET', '/config/providers');
    const out: Array<{ id: string; providerID: string; name: string; status?: string }> = [];
    for (const p of j.providers || []) {
      for (const [mid, m] of Object.entries(p.models || {})) {
        out.push({ id: m.id || mid, providerID: p.id, name: m.name || mid, status: m.status });
      }
    }
    return out;
  }

  listAgents(): Promise<Array<{ name: string; description?: string }>> {
    return this.req('GET', '/agent');
  }

  // ---- PTY (verified live on Windows) ----
  ptyCreate(directory: string, body: { command?: string; args?: string[]; cwd?: string; title?: string }): Promise<PtyInfo> {
    return this.req('POST', `/pty${this.dirQuery(directory)}`, body);
  }

  ptyList(directory: string): Promise<PtyInfo[]> {
    return this.req('GET', `/pty${this.dirQuery(directory)}`);
  }

  ptyGet(ptyID: string, directory: string): Promise<PtyInfo> {
    return this.req('GET', `/pty/${ptyID}${this.dirQuery(directory)}`);
  }

  ptyUpdate(ptyID: string, directory: string, body: { title?: string; size?: { rows: number; cols: number } }): Promise<PtyInfo> {
    return this.req('PUT', `/pty/${ptyID}${this.dirQuery(directory)}`, body);
  }

  ptyDelete(ptyID: string, directory: string): Promise<boolean> {
    return this.req('DELETE', `/pty/${ptyID}${this.dirQuery(directory)}`);
  }

  /** Base URL of the managed server (loopback only). */
  upstreamBase(): string {
    return this.baseUrl();
  }

  /** Basic-auth value for server-to-server upstream calls. */
  upstreamAuth(): string {
    return this.authHeaders().authorization || '';
  }

  // ---- event subscriptions (SSE, verified format: `data: {...}\n\n`) ----
  subscribe(directory: string): void {
    if (this.eventSubs.has(directory)) return;
    let stopped = false;
    let retries = 0;
    const connect = (): void => {
      if (stopped) return;
      void (async () => {
        try {
          const res = await fetch(`${this.baseUrl()}/event${this.dirQuery(directory)}`, { headers: this.authHeaders() });
          if (!res.ok || !res.body) throw new Error(`sse http ${res.status}`);
          retries = 0;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (stopped) {
              try {
                await reader.cancel();
              } catch {
                /* ignore */
              }
              return;
            }
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const m = raw.match(/^data:\s*(\{[\s\S]*\})$/m);
              if (!m) continue;
              try {
                const ev = JSON.parse(m[1]) as UpstreamEvent;
                this.onEvent?.(directory, ev);
              } catch {
                /* ignore malformed frame */
              }
            }
          }
        } catch {
          /* fall through to backoff */
        }
        if (stopped) return;
        retries = Math.min(retries + 1, 6);
        setTimeout(connect, 500 * 2 ** retries);
      })();
    };
    connect();
    this.eventSubs.set(directory, {
      stop: () => {
        stopped = true;
      },
    });
  }

  unsubscribe(directory: string): void {
    const sub = this.eventSubs.get(directory);
    if (sub) {
      try {
        sub.stop();
      } catch {
        /* ignore */
      }
      this.eventSubs.delete(directory);
    }
  }
}
