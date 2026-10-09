// Authentication: single-user password, httpOnly cookie sessions, double-
// submit CSRF for mutations. Remote control of a coding agent is privileged;
// every API route (except loopback-only first-run setup and the PWA shell)
// requires a valid session.
import crypto from 'node:crypto';
import type { AppConfig } from './config.ts';
import { hashPassword, randomToken, verifyPassword } from './config.ts';

export const SESSION_COOKIE = 'ocr_sid';
export const CSRF_COOKIE = 'ocr_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

interface Session {
  csrf: string;
  created: number;
  lastSeen: number;
}

export class Auth {
  private sessions = new Map<string, Session>();
  private config: AppConfig;
  private persist: () => void;

  constructor(config: AppConfig, persist: () => void) {
    this.config = config;
    this.persist = persist;
  }

  get setupRequired(): boolean {
    return !this.config.passwordHash && !process.env.OCR_PASSWORD;
  }

  /** Effective password check: env-provided initial password or stored hash. */
  private checkPassword(password: string): boolean {
    if (this.config.passwordHash) return verifyPassword(password, this.config.passwordHash);
    const envPw = process.env.OCR_PASSWORD;
    if (envPw && password === envPw) return true;
    return false;
  }

  setInitialPassword(password: string): void {
    if (password.length < 12) {
      const e = new Error('Password must be at least 12 characters') as Error & { status?: number };
      e.status = 400;
      throw e;
    }
    this.config.passwordHash = hashPassword(password);
    this.config.passwordSetAt = Date.now();
    delete process.env.OCR_PASSWORD;
    this.persist();
  }

  changePassword(current: string, next: string): void {
    if (!this.checkPassword(current)) {
      const e = new Error('Current password is incorrect') as Error & { status?: number };
      e.status = 403;
      throw e;
    }
    if (next.length < 12) {
      const e = new Error('New password must be at least 12 characters') as Error & { status?: number };
      e.status = 400;
      throw e;
    }
    this.config.passwordHash = hashPassword(next);
    this.config.passwordSetAt = Date.now();
    this.sessions.clear();
    this.persist();
  }

  login(password: string): { sid: string; csrf: string } | null {
    // Adopt an env-provided password into the store on first successful login.
    if (!this.config.passwordHash && process.env.OCR_PASSWORD) {
      if (password !== process.env.OCR_PASSWORD) return null;
      this.config.passwordHash = hashPassword(password);
      this.config.passwordSetAt = Date.now();
      delete process.env.OCR_PASSWORD;
      this.persist();
    } else if (!this.checkPassword(password)) {
      return null;
    }
    const sid = randomToken(24);
    const csrf = randomToken(24);
    this.sessions.set(sid, { csrf, created: Date.now(), lastSeen: Date.now() });
    return { sid, csrf };
  }

  logout(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
  }

  verify(sid: string | undefined): Session | null {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.created > SESSION_TTL_MS) {
      this.sessions.delete(sid);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  verifyCsrf(session: Session, header: string | string[] | undefined, cookie: string | undefined): boolean {
    const h = Array.isArray(header) ? header[0] : header;
    if (!h || !cookie) return false;
    if (h.length !== cookie.length || h.length < 16) return false;
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(cookie)) && cookie === session.csrf;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name: string, value: string, opts: { maxAge?: number; clear?: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.clear) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  else if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}
