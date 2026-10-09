// Unit tests: validation + allowlist guards.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HttpError,
  asId,
  asOptionalString,
  asString,
  badRequest,
  normalizeDir,
  withinAllowlist,
} from '../src/validate.ts';

describe('validate', () => {
  it('asString accepts normal strings, rejects empties and non-strings', () => {
    assert.equal(asString('hello', 'x'), 'hello');
    assert.throws(() => asString('', 'x'), HttpError);
    assert.throws(() => asString(42, 'x'), HttpError);
    assert.throws(() => asString('x'.repeat(501), 'x'), HttpError);
  });

  it('asOptionalString treats empty/missing as undefined', () => {
    assert.equal(asOptionalString(undefined, 'x'), undefined);
    assert.equal(asOptionalString('', 'x'), undefined);
    assert.equal(asOptionalString('a', 'x'), 'a');
    assert.throws(() => asOptionalString(7, 'x'), HttpError);
  });

  it('asId enforces prefixes and safe characters', () => {
    assert.equal(asId('ses_abc123', 'session', 'ses'), 'ses_abc123');
    assert.equal(asId('pty_1', 'pty', 'pty'), 'pty_1');
    assert.throws(() => asId('ses_../../etc', 'session', 'ses'), HttpError);
    assert.throws(() => asId('msg_1', 'session', 'ses'), HttpError);
    assert.throws(() => asId('ses_a b', 'session', 'ses'), HttpError);
  });

  it('badRequest carries status 400', () => {
    const e = badRequest('nope');
    assert.equal(e.status, 400);
    assert.equal(e.code, 'bad_request');
  });

  it('withinAllowlist matches roots and children only', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-allow-'));
    const child = path.join(base, 'proj');
    fs.mkdirSync(child);
    assert.equal(withinAllowlist(child, [base]), true);
    assert.equal(withinAllowlist(base, [base]), true);
    assert.equal(withinAllowlist(base + '-other', [base]), false);
    assert.equal(withinAllowlist(os.tmpdir(), [base]), false);
    assert.equal(normalizeDir(child).toLowerCase().startsWith(normalizeDir(base).toLowerCase()), true);
    fs.rmSync(base, { recursive: true, force: true });
  });
});
