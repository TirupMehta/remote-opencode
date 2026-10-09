// Tailscale detection (best-effort, cached). Used to bind the Tailnet IP and
// to show the phone URL. Never throws.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

let cache: { at: number; ip: string | null } | null = null;
const CACHE_MS = 30_000;

function candidates(): string[] {
  if (process.platform === 'win32') {
    return ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'];
  }
  return ['tailscale'];
}

function run(bin: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, ['ip', '-4'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout).trim().split(/\s+/)[0] || '');
    });
  });
}

/** The machine's Tailscale IPv4 (100.x.y.z), or null when absent/logged out. */
export async function getTailscaleIPv4(): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ip;
  let ip: string | null = null;
  for (const bin of candidates()) {
    try {
      const out = await run(bin);
      if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) {
        ip = out;
        break;
      }
    } catch {
      continue;
    }
  }
  cache = { at: Date.now(), ip };
  return ip;
}

export function tailscaleInstalled(): boolean {
  if (process.platform !== 'win32') return true; // PATH lookup is best-effort elsewhere
  return candidates().some((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

export interface ListenDecision {
  host: string;
  tailscaleIP: string | null;
  note: string;
}

/**
 * Decide which interface to bind. Explicit config always wins. Otherwise the
 * Tailnet IP is used only when authentication is configured (never expose an
 * unauthenticated remote terminal); loopback is the safe default.
 */
export function resolveListenHost(configuredHost: string | undefined, defaultHost: string, tailscaleIP: string | null, hasPassword: boolean): ListenDecision {
  if (configuredHost && configuredHost !== defaultHost) {
    return { host: configuredHost, tailscaleIP, note: `explicit host ${configuredHost}` };
  }
  if (tailscaleIP && hasPassword) {
    return { host: tailscaleIP, tailscaleIP, note: `tailscale ${tailscaleIP} (password is set)` };
  }
  if (tailscaleIP && !hasPassword) {
    return {
      host: defaultHost,
      tailscaleIP,
      note: 'tailscale detected but no password is set — staying on loopback until you set one',
    };
  }
  return { host: defaultHost, tailscaleIP, note: 'loopback only (no tailnet detected)' };
}
