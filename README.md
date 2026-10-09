# OpenCode Remote

A private, mobile-first remote control for the **OpenCode CLI**. All coding agents
keep running on your Windows laptop; your phone is just a remote control.

- See every OpenCode session, including ones started in laptop terminals.
- New laptop sessions appear on the phone automatically — nothing to import.
- Create sessions, continue conversations, stream replies, stop tasks, archive.
- Real interactive terminal (PowerShell) via OpenCode's native PTY support.
- Private access over your Tailnet. No cloud, no external AI API, no public URL.

## Prerequisites

- Windows 10/11 with **Node.js 22+** (`node --version`) and the **OpenCode CLI**
  (`opencode --version`, 1.18.x verified) installed and authenticated.
- Laptop and phone on the same private network. Recommended: **Tailscale**
  (free personal plan) on both devices for access away from home Wi-Fi.
- The laptop must stay **powered on, awake, and connected** while you use the
  remote. Remote control cannot wake or boot it.

## Quick start (laptop)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

The script checks Node.js, the OpenCode CLI, installs local tooling, prepares
terminal assets, and starts the server. First run prints something like:

```
OpenCode Remote is running: http://127.0.0.1:8787
First run: open the URL above ON THIS LAPTOP to set your remote password.
```

1. Open that URL **on the laptop** → set a remote password (12+ chars).
2. Go to **Settings → Project directories** and add the folders you work in
   (or pick from the discovered list). Only these can be written to from the
   phone; everything else is read-only.
3. Go to the **Status** tab for the URL to open on your phone.

Stop with `Ctrl+C`. Restart any time with the same command — sessions,
history, and settings survive restarts.

## Phone connection

### Option A — Tailscale (recommended)

1. Install Tailscale on the laptop and on the phone; sign in with the same
   account on both. (Download: https://tailscale.com/download)
2. Once the laptop is signed in, restart this app if it was running: it binds
   the Tailnet IP automatically (only when your remote password is set —
   otherwise it stays on loopback and says so).
3. On the laptop, note the Tailscale IP shown in the app's **Status** tab
   (looks like `http://100.x.y.z:8787`).
4. Open that URL in the phone browser → sign in with your remote password.
5. **Bookmark it**, or use *Add to Home Screen* / *Install app* for a
   full-screen app icon. It works as an installed PWA.

> Windows may ask once to allow Node.js through the firewall — click Allow.

### Option B — home Wi-Fi only

If both devices are on the same Wi-Fi, use one of the LAN URLs from the
**Status** tab (`http://192.168.x.x:8787`). This stops working off-network;
Tailscale keeps working everywhere.

> The server binds to `127.0.0.1` by default. When a Tailnet IP is detected
> **and** your remote password is set, it binds that IP automatically so the
> phone URL just works (stale/unreachable Tailnet IPs fall back to loopback).
> You can override with `OCR_HOST`. Never bind `0.0.0.0` yourself, and never
> expose this through router port-forwarding or public tunnels.

## Daily use

- **Sessions tab** — Active shows working/recent sessions; All shows history;
  search + project chips filter. Tapping a session opens the conversation.
- **Working / Active / Attention / Idle** — *Working* means your managed server
  is running it. *Active* means another process (laptop TUI/CLI) touched it
  recently — you can read it and send messages, which then run on your server.
- **Composer** — send follow-ups; **■** stops the task. Approvals appear inline
  (Allow once / Always / Deny).
- **Actions menu** — Rename, Archive (hides, keeps history), Close (same),
  Delete (permanent, requires confirmation; warns if work is in progress).
- **Terminal tab** — shells owned by the app, fully interactive. Laptop console
  windows that were already open **cannot** be attached — this is an OpenCode
  platform limit, and the app says so instead of faking it.
- **Status tab** — connectivity, last sync time, URLs, reconnect,
  troubleshooting.

## Configuration

Optional `.env` file in the repo root (see `.env.example`):

| Variable | Meaning |
|---|---|
| `OCR_PORT` | Port (default `8787`) |
| `OCR_HOST` | Bind address (default `127.0.0.1`) |
| `OCR_DATA_DIR` | Config/secrets dir (default `%APPDATA%/opencode-remote`) |
| `OCR_PASSWORD` | Initial password (adopted once, then cleared) |
| `OCR_PROJECTS` | Extra allowlisted dirs, comma-separated |
| `OPENCODE_BIN` | Custom path to the opencode executable |

Everything else (projects, defaults, password changes) lives in Settings.

## Security model

- Single-user password (scrypt hash, never in bundles/logs). Cookie session +
  CSRF tokens for mutations. Login rate-limited with a uniform delay.
- Same-origin only — no CORS. Managed OpenCode server gets a random per-boot
  password and listens on loopback only.
- Writes and terminals are confined to explicitly allowlisted directories.
  Provider keys from OpenCode are redacted before reaching the phone.
- Trusted-device model: anyone holding your remote password controls a coding
  agent with filesystem + shell access. Use a strong password, keep Tailscale
  ACLs default-private, lock your phone.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone page won't load | Laptop asleep/off-network? App running? Correct URL (Status tab)? |
| Stuck on “Reconnecting” | Tap **Reconnect now**; missed updates reconcile automatically. |
| New laptop session missing | Wait ~10s (poll interval); check Status → Last sync. |
| “Read-only” session | Its directory isn't allowlisted — add it in Settings. |
| Stop didn't stop work | Task is owned by a laptop TUI/CLI process — stop it there. |
| Terminal won't connect | End the session and open a new one; run `scripts\diagnose.ps1`. |
| Forgot password | Stop the app, delete `%APPDATA%\opencode-remote\config.json`, restart, redo first-run setup on the laptop. |

Run `scripts\diagnose.ps1` for versions, ports, Tailscale, and data paths.

## Known limitations (platform, not bugs)

- Existing laptop terminal windows / TUI processes cannot be attached to or
  observed as live terminals. Only app-created terminal sessions are
  interactive; agent conversations are fully controllable via messages.
- A task *running inside a laptop TUI/CLI* shows as **Active**, not Working,
  and Stop may not reach it — the result is reported honestly.
- The laptop must be awake and connected. There is no wake-on-LAN.

## Development

- `npm run check` — typecheck. `npm test` — unit tests.
  `$env:OCR_TEST_LIVE='1'; npm run test:integration` — live tests against a
  real managed server (temp dirs, tiny AI prompts, self-cleaning).
- See `AGENTS.md` for architecture, conventions, and API rules.
