import test from 'node:test';
import assert from 'node:assert/strict';
import { loadedModel, configOf, summarizeBounded } from '../lib/core.mjs';
import { imageBudget } from '../lib/images.mjs';

const vision = { type: 'vlm', arch: 'qwen35' };
const image = { type: 'image', attachment: { attachmentId: 'synthetic', mediaType: 'image/png', bytes: 1024, width: 512, height: 512 } };
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Read this image' }, image] }];

test('model discovery follows llm/vlm switches and validates exact loaded metadata', async () => {
  let row = { id: 'chosen', type: 'vlm', arch: 'qwen35', state: 'loaded', loaded_context_length: 16896 };
  let rows = [row];
  const fetcher = async () => ({ ok: true, json: async () => ({ data: rows }) });
  const inspect = () => loadedModel(configOf(), 'chosen', undefined, fetcher);
  assert.deepEqual(await inspect(), { capacity: 16896, ...vision });
  row.type = 'llm'; row.arch = 'llama'; row.loaded_context_length = 8192;
  assert.deepEqual(await inspect(), { capacity: 8192, type: 'llm', arch: 'llama' });
  for (const mutation of [{type:'embeddings'}, {state:'not-loaded'}, {id:'other'}, {loaded_context_length:undefined}]) {
    rows = [{ ...row, ...mutation }]; await assert.rejects(inspect(), /exact model/);
  }
  rows = [row, {...row}]; await assert.rejects(inspect(), /exact model/);
  rows = [null]; await assert.rejects(inspect(), /exact model/);
});

test('image budget uses request dimensions and preserves original image references', () => {
  const original = structuredClone(messages);
  const result = imageBudget(messages, vision);
  assert.ok(result.tokens > 512);
  assert.equal(result.messages[0].content[1].type, 'text');
  assert.deepEqual(messages, original);
  const large = [{ role:'tool', content:[{...image, attachment:{...image.attachment,width:2048,height:2048}}] }];
  assert.ok(imageBudget(large, vision).tokens > 8000);
  assert.ok(imageBudget(large, vision, () => ({width:512,height:512})).tokens < 2000);
  assert.equal(imageBudget([...messages,...messages], vision).tokens, result.tokens * 2);
});

test('text-only routes, unknown image architectures and malformed images fail closed', () => {
  assert.equal(imageBudget([{role:'user',content:'hello'}], {type:'llm'}).tokens, 0);
  assert.throws(() => imageBudget(messages, {type:'llm'}), /text model/);
  assert.throws(() => imageBudget(messages, {type:'vlm',arch:'unknown'}), /not verified/);
  for (const bad of [{...image,attachment:null},{...image,attachment:{...image.attachment,width:0}},{...image,offloaded:false},{type:'file'}]) {
    assert.throws(() => imageBudget([{role:'user',content:[bad]}], vision));
  }
  assert.throws(() => imageBudget([{role:'assistant',content:[image]}], vision));
  assert.throws(() => imageBudget([{role:'tool',content:[{type:'tool-result',content:[image]}]}], vision));
  assert.throws(() => imageBudget(messages, vision, () => ({width:NaN,height:512})));
});

test('offloaded images are text references; active images are never silently text-summarized', async () => {
  const offloaded = [{role:'user',content:[{...image,offloaded:true}]}];
  assert.equal(imageBudget(offloaded, {type:'llm'}).tokens, 0);
  let called = false;
  await assert.rejects(summarizeBounded(messages, {config:configOf(),capacity:16896,complete:async()=>{called=true;}}), /Cannot safely budget/);
  assert.equal(called, false);
});
