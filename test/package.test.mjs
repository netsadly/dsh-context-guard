import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline bundle imports are complete and dependency paths change runtime identity', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-guard-package-test-'));
  for (const path of ['index.mjs', 'lib', 'package.json', 'cordis.patch.yml']) await cp(new URL(`../${path}`, import.meta.url), join(cwd, path), { recursive: true });
  const script = fileURLToPath(new URL('../scripts/prepare-local.mjs', import.meta.url));
  await mkdir(join(cwd, 'sdk'));
  await writeFile(join(cwd, 'sdk/index.mjs'), '// synthetic SDK entry');
  const build = async host => {
    execFileSync(process.execPath, [script, host, join(cwd, 'sdk/index.mjs')], { cwd });
    const directory = join(cwd, 'private/local-plugin');
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const entry = await readFile(join(directory, manifest.main), 'utf8');
    assert.equal((entry.match(/file:\/\//g) ?? []).length, 4);
    assert.doesNotMatch(entry, /node_modules\/file:/);
    assert.doesNotMatch(entry, /from ['"]@deepseek-ai/);
    return manifest.main;
  };
  assert.notEqual(await build(join(cwd, 'host-one/node_modules')), await build(join(cwd, 'host-two/node_modules')));
});

test('invalid SDK paths fail before creating or replacing a bundle', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-guard-invalid-sdk-'));
  const script = fileURLToPath(new URL('../scripts/prepare-local.mjs', import.meta.url));
  const run = sdk => execFileSync(process.execPath, [script, 'host/node_modules', sdk], { cwd, stdio: 'pipe' });
  assert.throws(() => run(join(cwd, 'missing.mjs')));
  assert.deepEqual(await readdir(cwd), []);
  const out = join(cwd, 'private/local-plugin');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'package.json'), 'existing configuration');
  assert.throws(() => run(cwd));
  assert.equal(await readFile(join(out, 'package.json'), 'utf8'), 'existing configuration');
  assert.deepEqual(await readdir(out), ['package.json']);
});
