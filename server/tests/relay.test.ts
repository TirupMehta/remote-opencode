// Unit tests: sync engine snapshot/dedupe/preview with a fake upstream.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.ts';
import type { OpenCode } from '../src/opencode.ts';
import { Relay, extractPreview } from '../src/relay.ts';
import { Store } from '../src/store.ts';

function sess(id: string, dir: string, updated: number, title = 'T') {
  return {
    id,
    slug: 's',
    projectID: 'p1',
    directory: dir,
    title,
    time: { created: updated - 1000, updated },
  };
}

function fakeOc(sessions: ReturnType<typeof sess>[]) {
  return {
    onEvent: null,
    listSessions: async () => sessions,
    listProjects: async () => [{ id: 'p1', worktree: 'proj', name: 'proj' }],
  } as unknown as OpenCode;
}

function setup(sessions: ReturnType<typeof sess>[], projects: string[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-relay-'));
  const config: AppConfig = { port: 1, host: '127.0.0.1', dataDir, projects, pollSeconds: 10 };
  const store = new Store(dataDir);
  const relay = new Relay(fakeOc(sessions), config, store);
  return { relay, store, dataDir };
}

describe('relay', () => {
  it('snapshot sorts by activity and marks allowlisted sessions controllable', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-b-'));
    const now = Date.now();
    const { relay, store, dataDir } = setup(
      [sess('ses_old', dirA, now - 5000, 'Old'), sess('ses_new', dirB, now, 'New')],
      [dirA],
    );
    await relay.reconcile('test');
    const snap = relay.snapshot();
    assert.equal(snap.length, 2);
    assert.equal(snap[0].id, 'ses_new');
    assert.equal(snap[1].id, 'ses_old');
    assert.equal(snap.find((s) => s.id === 'ses_old')!.controllable, true);
    assert.equal(snap.find((s) => s.id === 'ses_new')!.controllable, false);
    assert.equal(snap[0].projectName, 'proj');
    store.setHidden('ses_old', true);
    assert.equal(relay.snapshot().find((s) => s.id === 'ses_old')!.hidden, true);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('reconcile drops deleted sessions', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-c-'));
    const now = Date.now();
    const list = [sess('ses_1', dirA, now)];
    const { relay, dataDir } = setup(list, [dirA]);
    await relay.reconcile('t1');
    assert.equal(relay.snapshot().length, 1);
    list.pop();
    await relay.reconcile('t2');
    assert.equal(relay.snapshot().length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dirA, { recursive: true, force: true });
  });

  it('event ring supports resume via eventsAfter', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-d-'));
    const { relay, dataDir } = setup([], [dirA]);
    const e1 = relay.emit('sync', { at: 1 });
    const e2 = relay.emit('sync', { at: 2 });
    assert.deepEqual(relay.eventsAfter(0).map((e) => e.id), [e1.id, e2.id]);
    assert.deepEqual(relay.eventsAfter(e1.id).map((e) => e.id), [e2.id]);
    assert.deepEqual(relay.eventsAfter(999), []);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dirA, { recursive: true, force: true });
  });

  it('extractPreview picks the newest text part', () => {
    const msgs = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'old question' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'final answer here' }] },
    ];
    assert.equal(extractPreview(msgs as never), 'final answer here');
    assert.equal(extractPreview([]), '');
  });

  it('watcher emits within one poll when a foreign message lands', async () => {
    let msgs: Array<{ info: { id: string; role: string; time: { created: number } }; parts: never[] }> = [
      { info: { id: 'msg_aaa', role: 'user', time: { created: 1 } }, parts: [] },
    ];
    const fake = {
      onEvent: null,
      listSessions: async () => [],
      listProjects: async () => [],
      listMessages: async () => msgs,
    } as unknown as OpenCode;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-watch-'));
    const config: AppConfig = { port: 1, host: '127.0.0.1', dataDir, projects: [], pollSeconds: 30 };
    const relay = new Relay(fake, config, new Store(dataDir));
    const got: Array<{ type: string; sessionID?: string }> = [];
    relay.onEvent((e) => got.push(e));
    relay.watch('ses_watch1', 'msg_aaa'); // phone rendered msg_aaa
    await new Promise((r) => setTimeout(r, 2300)); // one quiet poll
    assert.equal(got.filter((e) => e.type === 'session.message').length, 0);
    msgs = [...msgs, { info: { id: 'msg_bbb', role: 'assistant', time: { created: 2 } }, parts: [] }];
    await new Promise((r) => setTimeout(r, 2300));
    const hits = got.filter((e) => e.type === 'session.message' && e.sessionID === 'ses_watch1');
    assert.equal(hits.length, 1);
    relay.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
