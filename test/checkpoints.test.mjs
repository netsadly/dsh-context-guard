import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointStore, digest } from '../lib/checkpoints.mjs';
import { configOf, summarizeBounded } from '../lib/core.mjs';

const summary = n => `Goal: synthetic ${n}. Constraints: local. Completed: parsed. Files: demo.mjs. Failures: none. Pending: test. Next step: test.`;
const messages = [{ role: 'user', content: 'synthetic history '.repeat(3000) }];
const config = configOf({ summaryTokens: 1024, safetyTokens: 512 });

test('recovery survives new store instances and resumes without repeating completed model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-test-'));
  const identity = { session: 'synthetic', messages, model: 'fake', capacity: 8192, config };
  let calls = 0; let result; let pauses = 0;
  const seen = new Set();
  for (let attempt = 0; attempt < 12 && !result; attempt++) {
    try {
      result = await summarizeBounded(messages, { config, capacity: 8192, checkpoints: checkpointStore(root, identity), maxNewCalls: 2,
        complete: async request => { const key = digest(request); assert.equal(seen.has(key), false); seen.add(key); calls++; return { finish: 'stop', text: summary(calls) }; }
      });
    } catch (error) { assert.equal(error.code, 'CHECKPOINT_PAUSE'); pauses++; }
  }
  assert.ok(result); assert.ok(pauses > 0); assert.ok(calls > 2);
  const replay = await summarizeBounded(messages, { config, capacity: 8192, checkpoints: checkpointStore(root, identity), maxNewCalls: 2, complete: async () => assert.fail('must reuse') });
  assert.equal(replay.text, result.text);
  assert.equal(await checkpointStore(root, { ...identity, model: 'changed' }).get('anything'), undefined);
});

test('cancelled and incomplete calls are never checkpointed; corruption fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-test-'));
  const identity = { session: 'cancel-test' };
  const store = checkpointStore(root, identity);
  const controller = new AbortController();
  await assert.rejects(summarizeBounded([{ content: 'small' }], { config, capacity: 8192, checkpoints: store, signal: controller.signal,
    complete: async () => { controller.abort(); return { finish: 'stop', text: summary(1) }; }
  }));
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(summarizeBounded([{ content: 'small' }], { config, capacity: 8192, checkpoints: store,
    complete: async () => ({ finish: 'length', text: summary(1) })
  }), /incomplete/);
  assert.deepEqual(await readdir(root), []);
  await store.put('part', summary(1));
  await writeFile(join(root, digest(identity), `${digest('part')}.json`), '{broken');
  await assert.rejects(store.get('part'), /valid recovery checkpoint/);
});

test('cached work still obeys logical call limits', async () => {
  await assert.rejects(summarizeBounded(messages, { config: configOf({ ...config, maxCalls: 1 }), capacity: 8192,
    checkpoints: { get: async () => summary(1) }, complete: async () => assert.fail('cached')
  }), error => error.code === 'CALL_LIMIT');
});

test('nested provider overflows resume below persisted subdivision decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-test-'));
  const input = [{ content: 'z'.repeat(10000) }];
  const failed = new Set();
  let result;
  for (let attempt = 0; attempt < 15 && !result; attempt++) {
    let calls = 0;
    try {
      result = await summarizeBounded(input, { config, capacity: 30208, checkpoints: checkpointStore(root, { input }), maxNewCalls: 2,
        complete: async request => {
          calls++;
          if (request[1].content[0].text.length > 3500) {
            const key = digest(request);
            assert.equal(failed.has(key), false, 'must not repeat known overflow');
            failed.add(key);
            throw Object.assign(new Error('overflow'), { code: 'CONTEXT_WINDOW_EXCEEDED' });
          }
          return { finish: 'stop', text: summary(1) };
        }
      });
    } catch (error) { assert.equal(error.code, 'CHECKPOINT_PAUSE'); }
    assert.ok(calls <= 2);
  }
  assert.ok(result); assert.ok(failed.size >= 2);
});

test('resumed repaired summaries retain their full logical call cost', async () => {
  for (const maxCalls of [4, 6]) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-repair-cost-test-'));
    const input = [{ content: 'x'.repeat(65000) }];
    const repairConfig = configOf({ maxCalls });
    let physicalCalls = 0; let result; let lastError;
    for (let attempt = 0; attempt < 5 && !result; attempt++) {
      try {
        result = await summarizeBounded(input, { config: repairConfig, capacity: 30208,
          checkpoints: checkpointStore(root, { input, repairConfig }), maxNewCalls: 2,
          complete: async request => {
            physicalCalls++;
            return { finish: 'stop', text: request[0].content[0].text.includes('exactly seven nonempty lines') ? summary(1) : 'Goal: incomplete' };
          }
        });
      } catch (error) {
        lastError = error;
        if (error.code === 'CALL_LIMIT') break;
        assert.equal(error.code, 'CHECKPOINT_PAUSE');
      }
    }
    if (maxCalls === 4) {
      assert.equal(result, undefined);
      assert.equal(lastError.code, 'CALL_LIMIT');
      assert.equal(physicalCalls, 4);
    } else {
      assert.equal(result.calls, 6);
      assert.equal(physicalCalls, 6);
      const replay = await summarizeBounded(input, { config: repairConfig, capacity: 30208,
        checkpoints: checkpointStore(root, { input, repairConfig }), complete: async () => assert.fail('must reuse') });
      assert.equal(replay.calls, 6);
    }
  }
});

test('checkpoint call cost is validated and covered by the checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repair-cost-test-'));
  const identity = { session: 'cost-corruption' };
  const store = checkpointStore(root, identity);
  await assert.rejects(store.put('part', summary(1), 0));
  await store.put('part', summary(1), 2);
  await writeFile(join(root, digest(identity), `${digest('part')}.json`), JSON.stringify({
    version: 2, key: digest('part'), text: summary(1), calls: 1, checksum: digest({ text: summary(1), calls: 2 })
  }));
  await assert.rejects(store.get('part'), /valid recovery checkpoint/);
});
