// Unit tests: Tailnet bind decision (pure logic; probing is best-effort).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveListenHost } from '../src/tailscale.ts';

describe('resolveListenHost', () => {
  it('explicit config always wins', () => {
    const d = resolveListenHost('192.168.1.5', '127.0.0.1', '100.1.2.3', true);
    assert.equal(d.host, '192.168.1.5');
  });

  it('uses the Tailnet IP only when a password is set', () => {
    assert.equal(resolveListenHost(undefined, '127.0.0.1', '100.1.2.3', true).host, '100.1.2.3');
    assert.equal(resolveListenHost(undefined, '127.0.0.1', '100.1.2.3', false).host, '127.0.0.1');
  });

  it('stays on loopback without a tailnet', () => {
    assert.equal(resolveListenHost(undefined, '127.0.0.1', null, true).host, '127.0.0.1');
    assert.equal(resolveListenHost(undefined, '127.0.0.1', null, false).host, '127.0.0.1');
  });
});
