// Unit tests: dependency-free WebSocket framing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptKey, encodeFrame, parseFrame } from '../src/ws.ts';

function masked(opcode: number, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const mask = Uint8Array.from([1, 2, 3, 4]);
  const out = new Uint8Array(2 + 4 + body.length);
  out[0] = 0x80 | opcode;
  out[1] = 0x80 | body.length;
  out.set(mask, 2);
  for (let i = 0; i < body.length; i++) out[6 + i] = 0;
  for (let i = 0; i < body.length; i++) out[6 + i] = body[i] ^ mask[i % 4];
  return out;
}

describe('ws framing', () => {
  it('acceptKey matches the RFC 6455 example vector', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips a short server text frame', () => {
    const enc = encodeFrame(0x1, new TextEncoder().encode('hello'));
    assert.equal(enc[0] & 0x80, 0x80);
    const p = parseFrame(enc);
    assert.ok(p);
    assert.equal(p.frame.opcode, 0x1);
    assert.equal(new TextDecoder().decode(p.frame.payload), 'hello');
    assert.equal(p.rest.length, 0);
  });

  it('handles 16-bit lengths and leaves trailing bytes', () => {
    const big = 'x'.repeat(300);
    const enc = encodeFrame(0x2, new TextEncoder().encode(big));
    assert.equal(enc[1], 126);
    const withTail = new Uint8Array(enc.length + 3);
    withTail.set(enc, 0);
    withTail.set([9, 9, 9], enc.length);
    const p = parseFrame(withTail)!;
    assert.equal(p.frame.payload.length, 300);
    assert.deepEqual([...p.rest], [9, 9, 9]);
  });

  it('unmasks client frames', () => {
    const p = parseFrame(masked(0x1, 'hi there'))!;
    assert.equal(p.frame.opcode, 0x1);
    assert.equal(new TextDecoder().decode(p.frame.payload), 'hi there');
  });

  it('returns null for incomplete frames', () => {
    assert.equal(parseFrame(new Uint8Array([0x81])), null);
    assert.equal(parseFrame(new Uint8Array(0)), null);
  });

  it('rejects absurd lengths', () => {
    const evil = new Uint8Array([0x82, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0]);
    assert.throws(() => parseFrame(evil), /too large/);
  });
});
