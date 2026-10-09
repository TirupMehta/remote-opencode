// Synchronization engine: the bridge between OpenCode's world and phone
// clients.
//
// Sources of truth (verified):
//  - GET /session — full list from the shared SQLite DB; sees sessions from
//    every local process (TUI, CLI, serve). Polled for discovery.
//  - GET /session/:id/message — conversation history per session.
//  - GET /session/status?directory= — busy/idle/retry for sessions owned by
//    OUR serve process. Other processes' running tasks are NOT visible here
//    (verified: foreign statuses never appear); those sessions are reported
//    as `active-external` when they show fresh message activity.
//  - GET /event?directory= (SSE) — live bus for subscribed directories:
//    session.created/updated/deleted, message.updated, message.part.*,
//    session.status, session.idle, pty.*, permission/question events.
//
// Fan-out: normalized ClientEvents with monotonic IDs in a ring buffer so
// reconnecting phones can resume with ?lastId= without missing updates.
import type { OpenCode, UpstreamEvent } from './opencode.ts';
import type { AppConfig } from './config.ts';
import type { ClientEvent, ClientEventType, OpenCodeSession, SessionView } from './types.ts';
import { Store } from './store.ts';
import { normalizeDir, withinAllowlist } from './validate.ts';

interface SessionCache {
  session: OpenCodeSession;
  status: string; // idle|busy|retry (ours) or ''
  lastMsgAt: number;
  preview: string;
  msgCount: number;
}

const RING_SIZE = 500;
// How long another process's fresh message activity keeps a session in the
// Active tab. Generous on purpose: on a phone you glance every few minutes,
// and "recently active elsewhere" stays truthful much longer than 90 seconds.
const EXTERNAL_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const WATCH_MS = 2000;
const WATCH_TTL_MS = 120_000;

export class Relay {
  private oc: OpenCode;
  private config: AppConfig;
  private store: Store;
  private cache = new Map<string, SessionCache>();
  private events: ClientEvent[] = [];
  private nextId = 1;
  private listeners = new Set<(ev: ClientEvent) => void>();
  private lastSync = 0;
  private lastFullOk = false;
  private timer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private pendingRefresh = new Set<string>();
  private projectNames = new Map<string, string>(); // projectID -> name/worktree
  private watched = new Map<string, { until: number; lastMsgId: string; lastCompleted: boolean }>();
  private watchTimer: NodeJS.Timeout | null = null;

  constructor(oc: OpenCode, config: AppConfig, store: Store) {
    this.oc = oc;
    this.config = config;
    this.store = store;
    this.oc.onEvent = (dir, ev) => this.handleUpstream(dir, ev);
  }

  start(): void {
    this.resubscribe();
    void this.reconcile('boot');
    const pollMs = Math.max(5, this.config.pollSeconds) * 1000;
    this.timer = setInterval(() => void this.reconcile('poll'), pollMs);
    this.timer.unref?.();
    this.statusTimer = setInterval(() => void this.refreshStatuses(), 4000);
    this.statusTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
  }

  resubscribe(): void {
    // Subscribe to one SSE stream per allowlisted directory (bounded and
    // user-controlled). Discovery of sessions in OTHER directories happens
    // through the /session poll; those sessions are read-only.
    for (const d of this.config.projects) {
      try {
        this.oc.subscribe(normalizeDir(d));
      } catch {
        /* subscribe lazily retries internally */
      }
    }
  }

  getLastSync(): number {
    return this.lastSync;
  }

  /** A phone opened this conversation — poll its history fast for foreign writes.
   * baselineMsgId is the newest message the phone already rendered; anything
   * newer (or anything at all, when it rendered nothing) triggers a push. */
  watch(sessionID: string, baselineMsgId = ''): void {
    const existing = this.watched.get(sessionID);
    if (existing) {
      existing.until = Date.now() + WATCH_TTL_MS;
      return;
    }
    this.watched.set(sessionID, {
      until: Date.now() + WATCH_TTL_MS,
      lastMsgId: baselineMsgId,
      lastCompleted: true,
    });
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => void this.pollWatched(), WATCH_MS);
      this.watchTimer.unref?.();
    }
  }

  unwatch(sessionID: string): void {
    this.watched.delete(sessionID);
  }

  private async listMessagesQuiet(sessionID: string): Promise<void> {
    const msgs = await this.oc.listMessages(sessionID, 15);
    const w = this.watched.get(sessionID);
    const cached = this.cache.get(sessionID);
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    const lastId = last.info.id;
    const completed = !!(last.info.time && last.info.time.completed) || last.info.role === 'user';
    if (w) {
      if (lastId !== w.lastMsgId || completed !== w.lastCompleted) {
        // Foreign (or any) activity since the last check — push immediately.
        this.emit('session.message', { kind: 'watch', role: last.info.role }, sessionID);
        if (cached) {
          cached.lastMsgAt = Date.now();
          cached.preview = extractPreview(msgs);
          this.emitSessionsDebounced();
        }
      }
      w.lastMsgId = lastId;
      w.lastCompleted = completed;
    }
  }

  private async pollWatched(): Promise<void> {
    const now = Date.now();
    for (const [id, w] of [...this.watched]) {
      if (w.until < now) {
        this.watched.delete(id);
        continue;
      }
      try {
        await this.listMessagesQuiet(id);
      } catch {
        /* a deleted session simply stops matching; expiry cleans up */
      }
    }
    if (!this.watched.size && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  isFullOk(): boolean {
    return this.lastFullOk;
  }

  onEvent(fn: (ev: ClientEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type: ClientEventType, data: unknown, sessionID?: string): ClientEvent {
    const ev: ClientEvent = { id: this.nextId++, type, data, sessionID };
    this.events.push(ev);
    if (this.events.length > RING_SIZE) this.events.splice(0, this.events.length - RING_SIZE);
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* ignore */
      }
    }
    return ev;
  }

  eventsAfter(lastId: number, limit = 200): ClientEvent[] {
    return this.events.filter((e) => e.id > lastId).slice(-limit);
  }

  latestId(): number {
    return this.nextId - 1;
  }

  // ---- upstream handling ----
  private handleUpstream(_dir: string, ev: UpstreamEvent): void {
    const props = ev.properties || {};
    const sessionID =
      (props.sessionID as string) || (props.session as { id?: string } | undefined)?.id || (props.info as { sessionID?: string } | undefined)?.sessionID;
    switch (ev.type) {
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
        void this.reconcile('event:' + ev.type);
        break;
      case 'message.updated':
      case 'message.part.updated':
      case 'message.part.delta':
      case 'message.removed':
      case 'message.part.removed': {
        if (sessionID) {
          const cached = this.cache.get(sessionID);
          if (cached) {
            cached.lastMsgAt = Date.now();
          }
          const info = props.info as { role?: string } | undefined;
          const part = props.part as { type?: string; text?: string; data?: unknown } | undefined;
          if (ev.type === 'message.part.delta') {
            const delta = (props.delta as { text?: string }) || {};
            this.emit('session.delta', { delta: delta.text || '', partID: part && (part as { id?: string }).id }, sessionID);
          } else {
            this.emit('session.message', { kind: ev.type, role: info?.role, partType: part?.type }, sessionID);
            this.queueRefresh(sessionID);
          }
        }
        break;
      }
      case 'session.status':
      case 'session.idle': {
        if (sessionID) {
          const status = (props.status as { type?: string })?.type || (ev.type === 'session.idle' ? 'idle' : '');
          const cached = this.cache.get(sessionID);
          if (cached && status) cached.status = status;
          this.emit('session.status', { status: status || (ev.type === 'session.idle' ? 'idle' : 'unknown') }, sessionID);
          this.emitSessionsDebounced();
        }
        break;
      }
      case 'pty.created':
      case 'pty.updated':
      case 'pty.exited':
      case 'pty.deleted':
        this.emit('pty', { kind: ev.type, info: props.info || null });
        break;
      case 'permission.asked':
      case 'question.asked':
        this.emit('session.event', { kind: ev.type, properties: this.safeProps(props) }, sessionID);
        this.queueRefresh(sessionID || '');
        break;
      default:
        // Forward anything session-scoped we don't explicitly model so the
        // phone can show "something changed" instead of going stale.
        if (sessionID && (ev.type.startsWith('session.') || ev.type.startsWith('message.'))) {
          this.emit('session.event', { kind: ev.type }, sessionID);
          this.queueRefresh(sessionID);
        }
        break;
    }
  }

  private safeProps(props: Record<string, unknown>): Record<string, unknown> {
    // Never forward provider keys or tokens that some events embed.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (/key|token|secret|password/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  private refreshTimer: NodeJS.Timeout | null = null;
  private queueRefresh(sessionID: string): void {
    if (!sessionID) return;
    this.pendingRefresh.add(sessionID);
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const ids = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      void (async () => {
        let changed = false;
        for (const id of ids) {
          if (await this.refreshOne(id)) changed = true;
        }
        if (changed) this.emitSessionsDebounced();
      })();
    }, 800);
    this.refreshTimer.unref?.();
  }

  private sessionsTimer: NodeJS.Timeout | null = null;
  private emitSessionsDebounced(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      this.emit('sessions', { sessions: this.snapshot() });
    }, 500);
    this.sessionsTimer.unref?.();
  }

  private async refreshOne(sessionID: string): Promise<boolean> {
    const cached = this.cache.get(sessionID);
    if (!cached) return true; // unknown session -> full reconcile will pick it up
    try {
      const [session, msgs] = await Promise.all([
        this.oc.getSession(sessionID).catch(() => null),
        this.oc.listMessages(sessionID, 5).catch(() => null),
      ]);
      if (!session) {
        this.cache.delete(sessionID);
        return true;
      }
      cached.session = session;
      if (msgs && msgs.length) {
        cached.msgCount = Math.max(cached.msgCount, msgs.length);
        cached.lastMsgAt = Date.now();
        cached.preview = extractPreview(msgs);
      }
      return true;
    } catch {
      return false;
    }
  }

  // ---- reconciliation ----
  async reconcile(reason: string): Promise<void> {
    void reason;
    try {
      const [sessions, projects] = await Promise.all([
        this.oc.listSessions(),
        this.oc.listProjects().catch(() => [] as Array<{ id: string; worktree: string; name?: string }>),
      ]);
      this.projectNames.clear();
      for (const p of projects) this.projectNames.set(p.id, p.name || p.worktree);
      const seen = new Set<string>();
      let changed = this.cache.size === 0;
      for (const s of sessions) {
        seen.add(s.id);
        const prev = this.cache.get(s.id);
        if (!prev) {
          this.cache.set(s.id, {
            session: s,
            status: '',
            lastMsgAt: s.time.updated,
            preview: '',
            msgCount: 0,
          });
          changed = true;
          // Previews for brand-new sessions are fetched lazily on open.
        } else if (prev.session.time.updated !== s.time.updated || prev.session.title !== s.title) {
          prev.session = s;
          prev.lastMsgAt = Math.max(prev.lastMsgAt, s.time.updated);
          changed = true;
          void this.refreshPreview(s.id);
        }
      }
      for (const id of [...this.cache.keys()]) {
        if (!seen.has(id)) {
          this.cache.delete(id);
          changed = true;
        }
      }
      this.lastSync = Date.now();
      this.lastFullOk = true;
      if (changed) this.emit('sessions', { sessions: this.snapshot(), reason: 'reconcile' });
      else this.emit('sync', { at: this.lastSync });
    } catch {
      this.lastFullOk = false;
      this.emit('health', await this.health());
    }
  }

  private async refreshPreview(sessionID: string): Promise<void> {
    const cached = this.cache.get(sessionID);
    if (!cached || cached.preview) return;
    try {
      const msgs = await this.oc.listMessages(sessionID, 10);
      cached.preview = extractPreview(msgs);
      cached.msgCount = msgs.length;
      this.emitSessionsDebounced();
    } catch {
      /* preview is best-effort */
    }
  }

  private async refreshStatuses(): Promise<void> {
    // Query busy/idle per allowlisted directory (status is directory-scoped).
    let changed = false;
    const dirs = new Set<string>();
    for (const c of this.cache.values()) {
      try {
        dirs.add(normalizeDir(c.session.directory));
      } catch {
        /* ignore */
      }
    }
    for (const d of this.config.projects) {
      try {
        dirs.add(normalizeDir(d));
      } catch {
        /* ignore */
      }
    }
    for (const dir of dirs) {
      let st: Record<string, { type: string }>;
      try {
        st = await this.oc.sessionStatus(dir);
      } catch {
        continue;
      }
      for (const [id, v] of Object.entries(st)) {
        const cached = this.cache.get(id);
        if (cached && cached.status !== v.type) {
          cached.status = v.type;
          changed = true;
          this.emit('session.status', { status: v.type }, id);
        }
      }
      // Sessions previously busy that disappeared from every status map are
      // only marked idle when their messages settle (avoid flapping).
    }
    if (changed) this.emitSessionsDebounced();
  }

  snapshot(): SessionView[] {
    const now = Date.now();
    const roots = this.config.projects;
    const out: SessionView[] = [];
    for (const c of this.cache.values()) {
      const s = c.session;
      let state: SessionView['state'] = 'idle';
      if (c.status === 'busy') state = 'running';
      else if (c.status === 'retry') state = 'attention';
      else if (now - Math.max(c.lastMsgAt, s.time.updated) < EXTERNAL_ACTIVE_WINDOW_MS && c.status !== 'idle') {
        // Fresh activity but our server reports nothing: driven elsewhere.
        // Labeled honestly — never presented as locally "running".
        if (c.msgCount > 0 || c.preview) state = 'active-external';
      }
      let controllable = true;
      try {
        controllable = roots.length === 0 ? true : withinAllowlist(s.directory, roots);
      } catch {
        controllable = false;
      }
      out.push({
        ...s,
        projectName: displayProject(this.projectNames.get(s.projectID || ''), s.directory),
        state,
        controllable,
        hidden: this.store.isHidden(s.id),
        lastActivity: Math.max(c.lastMsgAt, s.time.updated),
        preview: c.preview,
        messageCount: c.msgCount || undefined,
      });
    }
    out.sort((x, y) => y.lastActivity - x.lastActivity);
    return out;
  }

  getCached(id: string): SessionCache | undefined {
    return this.cache.get(id);
  }

  async health(): Promise<{ ok: boolean; opencode: { reachable: boolean; version: string }; lastSync: number; sessions: number }> {
    return {
      ok: this.oc.isHealthy(),
      opencode: { reachable: this.oc.isHealthy(), version: this.oc.getVersion() },
      lastSync: this.lastSync,
      sessions: this.cache.size,
    };
  }
}

function projectBase(directory: string): string {
  const parts = directory.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || directory;
}

/** The catch-all "global" project reports worktree "/" — useless as a label,
 * so fall back to the directory's own folder name. */
function displayProject(name: string | undefined, directory: string): string {
  if (!name || name === '/' || name === 'global') return projectBase(directory);
  return name;
}

export function extractPreview(msgs: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string; [k: string]: unknown }> }>): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        const t = p.text.trim().replace(/\s+/g, ' ');
        return t.length > 160 ? t.slice(0, 160) + '…' : t;
      }
    }
  }
  return '';
}
