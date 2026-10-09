// Runtime configuration + secrets. Secrets live in the data dir (never in the
// repo, never in client bundles). Non-secret overrides via env / .env file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  projects: string[]; // allowlisted working directories
  defaultModel?: { providerID: string; id: string };
  defaultAgent?: string;
  pollSeconds: number;
  passwordHash?: string; // scrypt hash, "salt:derived"
  passwordSetAt?: number;
}

const DEFAULT_PORT = 8787;

export function dataDirDefault(): string {
  const base =
    process.env.APPDATA ||
    (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.config'));
  return path.join(base, 'opencode-remote');
}

function loadDotEnv(repoRoot: string): void {
  for (const p of [path.join(repoRoot, '.env'), path.join(process.cwd(), '.env')]) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || process.env[m[1]] !== undefined) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!v || v.startsWith('#')) continue;
        process.env[m[1]] = v;
      }
      break;
    } catch {
      /* no .env — fine */
    }
  }
}

export function repoRoot(): string {
  // server/src/config.ts -> repo root
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

export function loadConfig(): { config: AppConfig; secretsPath: string; firstRun: boolean; hostExplicit: boolean } {
  const root = repoRoot();
  loadDotEnv(root);
  const dataDir = process.env.OCR_DATA_DIR || dataDirDefault();
  fs.mkdirSync(dataDir, { recursive: true });
  const secretsPath = path.join(dataDir, 'config.json');
  let fileCfg: Partial<AppConfig> = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as Partial<AppConfig>;
  } catch {
    fileCfg = {};
  }
  const envProjects = splitList(process.env.OCR_PROJECTS);
  const config: AppConfig = {
    port: Number(process.env.OCR_PORT || fileCfg.port || DEFAULT_PORT),
    host: process.env.OCR_HOST || (fileCfg.host as string) || '127.0.0.1',
    dataDir,
    projects: [...new Set([...(fileCfg.projects || []), ...envProjects])],
    defaultModel: fileCfg.defaultModel,
    defaultAgent: fileCfg.defaultAgent,
    pollSeconds: Number(process.env.OCR_POLL_SECONDS || 5),
    passwordHash: fileCfg.passwordHash,
    passwordSetAt: fileCfg.passwordSetAt,
  };
  const firstRun = !config.passwordHash && !process.env.OCR_PASSWORD;
  // A persisted loopback host is the default, not an explicit user choice —
  // otherwise the first settings save would permanently disable Tailnet bind.
  const fileHostExplicit = !!fileCfg.host && !isLoopbackHost(fileCfg.host);
  const hostExplicit = !!process.env.OCR_HOST || fileHostExplicit;
  return { config, secretsPath, firstRun, hostExplicit };
}

export function saveConfig(secretsPath: string, config: AppConfig): void {
  const payload = {
    port: config.port,
    host: config.host,
    projects: config.projects,
    defaultModel: config.defaultModel,
    defaultAgent: config.defaultAgent,
    pollSeconds: config.pollSeconds,
    passwordHash: config.passwordHash,
    passwordSetAt: config.passwordSetAt,
  };
  const tmp = secretsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, secretsPath);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(expected));
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
