import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only hashes form path components. Each immutable result is published atomically.
export function checkpointStore(root, identity) {
  const directory = join(root, digest(identity));
  const store = {
    async getRecord(part) {
      const key = digest(part);
      try {
        const handle = await open(join(directory, `${key}.json`), 'r');
        let raw;
        try {
          const buffer = Buffer.alloc(65537);
          let size = 0;
          while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size > 65536) throw new Error('Checkpoint exceeds size limit');
          raw = buffer.subarray(0, size).toString('utf8');
        } finally { await handle.close(); }
        const record = JSON.parse(raw);
        if (record.version !== 2 || record.key !== key || typeof record.text !== 'string' || ![1, 2].includes(record.calls) || record.checksum !== digest({ text: record.text, calls: record.calls })) throw new Error('Invalid checkpoint');
        return { text: record.text, calls: record.calls };
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw new Error('Cannot read a valid recovery checkpoint; original history retained', { cause: error });
      }
    },
    async get(part) { return (await store.getRecord(part))?.text; },
    async put(part, text, calls = 1) {
      if (typeof text !== 'string' || ![1, 2].includes(calls)) throw new Error('Invalid checkpoint result');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const key = digest(part);
      const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 2, key, text, calls, checksum: digest({ text, calls }) }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(directory, `${key}.json`));
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
  };
  store.getSplit = async part => (await store.get({ split: part })) === 'split-v1';
  store.markSplit = part => store.put({ split: part }, 'split-v1');
  return store;
}
