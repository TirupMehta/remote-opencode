// Unit tests: password auth, sessions, CSRF.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../src/config.ts';
import { Auth } from '../src/auth.ts';

function cfg(): AppConfig {
  return {
    port: 8787,
    host: '127.0.0.1',
    dataDir: 'x',
    projects: [],
    pollSeconds: 10,
  };
}

describe('auth', () => {
  it('setupRequired until a password exists', () => {
    const a = new Auth(cfg(), () => {});
    assert.equal(a.setupRequired, true);
    a.setInitialPassword('long-enough-password');
    assert.equal(a.setupRequired, false);
  });

  it('rejects short passwords', () => {
    const a = new Auth(cfg(), () => {});
    assert.throws(() => a.setInitialPassword('short'), /12/);
  });

  it('login succeeds with the right password, fails otherwise', () => {
    const a = new Auth(cfg(), () => {});
    a.setInitialPassword('correct-horse-pw-1');
    assert.equal(a.login('wrong-password-xyz'), null);
    const s = a.login('correct-horse-pw-1');
    assert.ok(s && s.sid.length > 10 && s.csrf.length > 10);
    assert.ok(a.verify(s.sid));
    assert.equal(a.verify('nope'), null);
  });

  it('logout invalidates the session', () => {
    const a = new Auth(cfg(), () => {});
    a.setInitialPassword('correct-horse-pw-1');
    const s = a.login('correct-horse-pw-1')!;
    a.logout(s.sid);
    assert.equal(a.verify(s.sid), null);
  });

  it('changePassword rotates credentials and drops sessions', () => {
    const a = new Auth(cfg(), () => {});
    a.setInitialPassword('old-password-1234');
    const s = a.login('old-password-1234')!;
    assert.throws(() => a.changePassword('wrong', 'new-password-1234'), /incorrect/);
    a.changePassword('old-password-1234', 'new-password-1234');
    assert.equal(a.verify(s.sid), null);
    assert.equal(a.login('old-password-1234'), null);
    assert.ok(a.login('new-password-1234'));
  });

  it('CSRF check requires header === session-bound cookie token', () => {
    const a = new Auth(cfg(), () => {});
    a.setInitialPassword('correct-horse-pw-1');
    const s = a.login('correct-horse-pw-1')!;
    const sess = a.verify(s.sid)!;
    assert.equal(a.verifyCsrf(sess, s.csrf, s.csrf), true);
    assert.equal(a.verifyCsrf(sess, 'wrong', s.csrf), false);
    assert.equal(a.verifyCsrf(sess, undefined, s.csrf), false);
    assert.equal(a.verifyCsrf(sess, s.csrf, 'other'), false);
  });
});
