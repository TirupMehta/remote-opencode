// Request validation, path guards, allowlist enforcement.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(msg: string): HttpError {
  return new HttpError(400, 'bad_request', msg);
}
export function unauthorized(msg = 'Authentication required'): HttpError {
  return new HttpError(401, 'unauthorized', msg);
}
export function forbidden(msg: string): HttpError {
  return new HttpError(403, 'forbidden', msg);
}
export function notFound(msg: string): HttpError {
  return new HttpError(404, 'not_found', msg);
}
export function conflict(msg: string): HttpError {
  return new HttpError(409, 'conflict', msg);
}

export function asString(v: unknown, name: string, maxLen = 500): string {
  if (typeof v !== 'string' || v.length === 0) throw badRequest(`${name} must be a non-empty string`);
  if (v.length > maxLen) throw badRequest(`${name} is too long (max ${maxLen})`);
  return v;
}

export function asOptionalString(v: unknown, name: string, maxLen = 500): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw badRequest(`${name} must be a string`);
  if (v.length > maxLen) throw badRequest(`${name} is too long (max ${maxLen})`);
  return v;
}

export function asId(v: unknown, name: string, prefix: string): string {
  const s = asString(v, name, 100);
  if (!s.startsWith(prefix)) throw badRequest(`${name} must start with ${prefix}`);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw badRequest(`${name} has invalid characters`);
  return s;
}

const longPathCache = new Map<string, string>();

/**
 * Expand Windows 8.3 short-name segments (e.g. TIRUPM~1) to the canonical
 * long form. Node's realpathSync does NOT do this on Windows, so without it
 * `C:\Users\TIRUPM~1\...` and `C:\Users\Tirup Mehta\...` compare as different
 * directories. Only invoked for paths containing `~`, results cached.
 */
function expandShortSegments(p: string): string {
  if (process.platform !== 'win32' || !p.includes('~')) return p;
  const hit = longPathCache.get(p);
  if (hit !== undefined) return hit;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath ${JSON.stringify(p)}).FullName`],
      { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    if (out) {
      longPathCache.set(p, out);
      return out;
    }
  } catch {
    /* fall through to the input */
  }
  longPathCache.set(p, p);
  return p;
}

export function normalizeDir(p: string): string {
  // Resolve 8.3 short names / symlinks where possible so allowlist checks are stable.
  let out = p;
  try {
    out = fs.realpathSync(p);
  } catch {
    out = path.resolve(p);
  }
  return path.normalize(expandShortSegments(out));
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when `dir` is inside (or equal to) one of the allowlisted roots. */
export function withinAllowlist(dir: string, roots: string[]): boolean {
  const norm = normalizeDir(dir).toLowerCase();
  for (const r of roots) {
    const root = normalizeDir(r).toLowerCase();
    if (norm === root || norm.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
  }
  return false;
}

export function requireAllowlistedDir(dir: string, roots: string[], what: string): string {
  const norm = normalizeDir(dir);
  if (!dirExists(norm)) throw badRequest(`${what} directory does not exist: ${dir}`);
  if (!withinAllowlist(norm, roots)) throw forbidden(`${what} directory is outside the allowed projects`);
  return norm;
}
