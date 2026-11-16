import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTokenCounter } from '../lib/tokenizer.mjs';
import { configOf } from '../lib/core.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('queued and active calls share a bounded timeout; abandoned RPC stays locked',async()=>{
 let resolve;let calls=0;
 class Client {llm={createDynamicHandle:()=>({countTokens:()=>{calls++;return new Promise(r=>{resolve=r;});}})};}
 const count=makeTokenCounter(Client,{...configOf(),capacityTimeoutMs:30});
 const first=assert.rejects(count('test',[]),{name:'TimeoutError'});
 const queued=assert.rejects(count('test',[]),{name:'TimeoutError'});
 await Promise.all([first,queued,delay(50)]);
 assert.equal(calls,1);await assert.rejects(count('test',[]),/still pending/);
 resolve(10);await new Promise(r=>setImmediate(r));
 const next=count('test',[]);resolve(20);assert.equal(await next,534);
});

test('healthy overlapping counts serialize without starting parallel RPCs', async()=>{
 const resolvers=[];let calls=0;
 class Client {llm={createDynamicHandle:()=>({countTokens:()=>{calls++;return new Promise(r=>resolvers.push(r));}})};}
 const count=makeTokenCounter(Client,configOf());
 const first=count('test',[]);const second=count('test',[]);
 assert.equal(calls,1);resolvers.shift()(10);assert.equal(await first,523);
 await new Promise(r=>setImmediate(r));assert.equal(calls,2);
 resolvers.shift()(20);assert.equal(await second,534);
});

test('waiting callers are bounded and cancellation never starts another RPC',async()=>{
 let resolve;let calls=0;
 class Client {llm={createDynamicHandle:()=>({countTokens:()=>{calls++;return new Promise(r=>{resolve=r;});}})};}
 const count=makeTokenCounter(Client,configOf());const first=count('test',[]);
 const controllers=Array.from({length:4},()=>new AbortController());
 const waiting=controllers.map(c=>{const p=count('test',[],[],c.signal);return assert.rejects(p,/cancelled/);});
 await assert.rejects(count('test',[]),/queue is full/);
 controllers.forEach(c=>c.abort(new Error('cancelled')));await Promise.all(waiting);
 assert.equal(calls,1);resolve(10);await first;
});

test('cancelled tokenizer RPC holds its single-flight lock until it settles', async () => {
  let resolve; let calls = 0;
  class Client { llm = { createDynamicHandle: () => ({ countTokens: () => { calls++; return new Promise(r => { resolve = r; }); } }) }; }
  const count = makeTokenCounter(Client, configOf());
  const controller = new AbortController();
  const pending = count('test', [], [], controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(count('test', []), /still pending/);
  assert.equal(calls, 1);
  resolve(10);
  await Promise.resolve();
  const next = count('test', []);
  resolve(10);
  assert.equal(await next, 523);
});
