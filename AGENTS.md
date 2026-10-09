# AGENTS.md — OpenCode Remote

Private, mobile-first remote control for the OpenCode CLI. Laptop runs everything;
the phone is a remote control. No cloud, no external AI API, no runtime dependencies.

## Architecture

```
Phone (PWA) ⇄ Node backend (this repo, :8787) ⇄ managed `opencode serve` (127.0.0.1, random port)
                                                        ↕ shared SQLite DB (~/.local/share/opencode/opencode.db)
                                              laptop TUI / CLI sessions
```

- Backend owns one `opencode serve` child (per-boot basic-auth password, loopback only).
- Discovery: `GET /session` reads the shared DB → sees sessions from every local
  process. Polled every `pollSeconds` (default 10s); full reconcile on boot/reconnect.
- Liveness: `GET /session/status?directory=` (busy/idle/retry, **own process only**)
  plus `GET /event?directory=` SSE per allowlisted directory (message/part deltas,
  session.status/idle, pty.*, permission/question events).
- Phone sync: our own SSE at `/api/stream` with monotonic IDs + `?lastId=` resume
  and a 500-event ring buffer. Open conversations are `POST /api/watch`ed and
  polled every 2s for foreign writes (verified 1.5s detection); heartbeats
  renew the watch, TTL expiry + release prune it.
- Terminal: native OpenCode PTY (`POST /pty`, WS `/pty/{id}/connect`). Proxied
  phone↔serve with a dependency-free WS server (`server/src/ws.ts`). Upstream uses
  basic-auth headers (short-lived tickets proved flaky — see probes).
- OpenCode is the source of truth. Local store keeps only: hidden session IDs,
  idempotency keys, config, password hash (`%APPDATA%/opencode-remote/`).

## Directory structure

- `server/src/` — backend TS: `main.ts` (boot), `api.ts` (routes), `opencode.ts`
  (serve manager + verified REST client), `relay.ts` (reconcile + fan-out),
  `auth.ts` (password/cookie/CSRF), `ws.ts` (WS server + PTY proxy),
  `store.ts`, `config.ts`, `validate.ts`, `types.ts`.
- `server/tests/` — unit (`*.test.ts`, always run) + `integration.test.ts`
  (live; needs `OCR_TEST_LIVE=1`, uses temp dirs, tiny real AI prompts, cleans up).
- `web/` — static PWA (`index.html`, `styles.css`, `app.js`, `sw.js`,
  `manifest.webmanifest`, `vendor/` built by `scripts/setup-web.mjs`).
- `scripts/` — `start.ps1` (the one startup command), `diagnose.ps1`, `setup-web.mjs`.

## Commands

- Start: `powershell -ExecutionPolicy Bypass -File scripts\start.ps1`
- Typecheck: `npm run check` (tsc, noEmit). Tests: `npm test`.
  Live integration: `$env:OCR_TEST_LIVE='1'; npm run test:integration`.
- Diagnose: `scripts\diagnose.ps1`. Syntax-check frontend: `node --check web\app.js`.

## TypeScript conventions (read this — no build step)

- Backend runs **directly on Node 22+ via type stripping**. Write *erasable* TS only:
  no enums, no namespaces, no parameter properties, no non-null assertions tricks —
  if `npm run check` passes and `node server/src/main.ts` boots, you're fine.
- Relative imports MUST use explicit `.ts` extensions (`./x.ts`).
- `strict` is on. Prefer `unknown` + validators in `validate.ts` over `any`.
- Runtime dependencies are banned (backend + frontend). DevDeps only: typescript,
  @types/node, @xterm/xterm, @xterm/addon-fit (vendored into `web/vendor/`).

## Security requirements (non-negotiable)

- Bind `127.0.0.1` by default. Auto-bind of the Tailnet IP happens only when a
  password is configured (`resolveListenHost` in `tailscale.ts`); explicit
  `OCR_HOST`/config always wins; unreachable Tailnet IPs fall back to loopback.
  Refuse non-loopback bind without a password.
- All `/api/*` (except loopback-only first-run setup + login/status) need the
  session cookie; all mutations need the `x-csrf-token` double-submit header.
- Writes (create/message/abort/permissions/PTY) require the directory to be in
  the project allowlist. Reads require auth only. Never infer directories.
- Never forward upstream secrets: `/config/providers` is redacted to
  id/provider/name; event props matching key|token|secret|password are dropped.
- No CORS headers (same-origin only). No `0.0.0.0`, no port-forwarding, no public
  tunnels. Login is rate-limited with a uniform delay. No secrets in logs/bundles.

## Session identity & routing rules

- Session ID (`ses_…`) is the ONLY identity. Never use titles/paths as keys.
- **Always pass `?directory=`** on session/PTY/status/event calls (server scopes by
  directory; unscoped calls return `{}`/404).
- Normalize paths with `normalizeDir()` (handles Windows 8.3 short names).
- Execution state mapping: `busy`→running (ours), `retry`→attention; fresh message
  activity with no own status→`active-external` (labelled, never "running").
- Idempotency: every create/message accepts a client key; retries return
  `{duplicate:true}` instead of duplicating work.

## OpenCode API verification requirements

Every upstream endpoint/flag/shape used in `opencode.ts` was verified against
opencode **1.18.35** via `/doc` OpenAPI + live probes (see /tmp oc_probe*.cjs
methodology). Before adding any endpoint: check the local `/doc` spec, then prove
it with a throwaway live call. Re-verify after any OpenCode upgrade.

Verified working: list/get/create(`?directory=`)/patch-title/delete session,
list messages, `prompt_async` 204, abort, permission reply (`once|always|reject`),
question reply/reject, project list, providers (redacted), agents, session status
(directory-scoped), `data:`-only SSE event format, PTY create/list/get/resize/
delete + WS connect with basic-auth headers (binary `0x00`+cursor meta frames),
serve basic-auth enforcement (401/200).

Known hard limits (do NOT work around by faking):
- No attaching to existing TUI/CLI terminal processes or PTYs owned by other
  processes — only PTYs created by our managed server are interactive here.
- `session.status` never shows tasks owned by other processes; those surface as
  `active-external` via message activity only.
- Abort reliably stops phone-started tasks; laptop-owned running tasks may not
  stop — report the upstream result, never fake it.

## Rules

- Never fabricate sessions, statuses, messages, or terminal output. Empty/error/
  offline states must be real and explicit. Unsupported actions get a clear
  error, not a fake success.
- No mock production data anywhere in the served path. No placeholder buttons.
- Keep it small: no frameworks, no DB, no Redis, no Docker. Justify every dep.
- Update this file + README whenever architecture, routes, or limits change.
