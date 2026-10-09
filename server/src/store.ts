// Minimal local persistence. OpenCode is the source of truth for sessions and
// history; this store keeps only what cannot be recovered from OpenCode:
// hidden (archived) session IDs, idempotency keys, and client-cursor hints.
import fs from 'node:fs';
import path from 'node:path';

interface StoreData {
  hidden: Record<string, number>; // sessionID -> hiddenAt
  seenKeys: Record<string, number>; // idempotencyKey -> firstSeenAt
}

export class Store {
  private file: string;
  private data: StoreData = { hidden: {}, seenKeys: {} };

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'store.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoreData>;
      if (raw.hidden && typeof raw.hidden === 'object') this.data.hidden = raw.hidden;
      if (raw.seenKeys && typeof raw.seenKeys === 'object') this.data.seenKeys = raw.seenKeys;
    } catch {
      /* fresh store */
    }
    this.gc();
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch {
      /* best effort; in-memory state still works */
    }
  }

  private gc(): void {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    let dirty = false;
    for (const [k, v] of Object.entries(this.data.seenKeys)) {
      if (v < cutoff) {
        delete this.data.seenKeys[k];
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  isHidden(sessionID: string): boolean {
    return this.data.hidden[sessionID] !== undefined;
  }

  setHidden(sessionID: string, hidden: boolean): void {
    if (hidden) this.data.hidden[sessionID] = Date.now();
    else delete this.data.hidden[sessionID];
    this.persist();
  }

  hiddenIds(): string[] {
    return Object.keys(this.data.hidden);
  }

  /** Returns true when the key was already seen (duplicate request). */
  seenKey(key: string): boolean {
    if (this.data.seenKeys[key] !== undefined) return true;
    this.data.seenKeys[key] = Date.now();
    this.persist();
    return false;
  }
}
