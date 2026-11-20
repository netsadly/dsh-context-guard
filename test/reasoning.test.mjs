import test from 'node:test';
import assert from 'node:assert/strict';
import { requireReasoningAnswer, REASONING_ONLY_EOS } from '../lib/reasoning.mjs';
const thought={type:'reasoning-delta',index:0,text:'Checking constraints.'};
const stop={type:'finish',reason:{kind:'stop'}};
async function collect(chunks,signal){const out=[];for await(const c of requireReasoningAnswer((async function*(){yield* chunks;})(),signal))out.push(c);return out;}
test('reasoning-only normal EOS is a failed attempt, preserving reasoning and usage',async()=>{
 const usage={type:'usage',usage:{outputTokens:400}};
 const input=[thought,usage,stop];const before=structuredClone(input);
 const out=await collect(input);assert.deepEqual(out.slice(0,2),input.slice(0,2));assert.equal(out.at(-1).reason.failure.code,REASONING_ONLY_EOS);assert.deepEqual(input,before);
});
test('visible answers and tool calls are never replayed as reasoning-only EOS',async()=>{
 for(const answer of [{type:'text-delta',index:1,text:'42'}, {type:'block-end',index:1,block:{type:'text',text:'42'}}, {type:'tool-call-delta',index:1,argumentsDelta:'{}'}, {type:'block-start',index:1,blockType:'tool-call'}, {type:'block-end',index:1,block:{type:'tool-call',name:'write'}}])assert.deepEqual(await collect([thought,answer,stop]),[thought,answer,stop]);
});
test('completed reasoning blocks and whitespace answers still detect missing final output',async()=>{
 const out=await collect([{type:'block-end',index:0,block:{type:'reasoning',text:'work'}},{type:'text-delta',index:1,text:'  \n'},stop]);assert.equal(out.at(-1).reason.failure.code,REASONING_ONLY_EOS);
});
test('other finish reasons, empty streams, missing finish and cancellation keep their semantics',async()=>{
 for(const kind of ['max-tokens','tool-calls','error','aborted']){const end={type:'finish',reason:{kind}};assert.deepEqual(await collect([thought,end]),[thought,end]);}
 assert.deepEqual(await collect([stop]),[stop]);assert.deepEqual(await collect([thought]),[thought]);
 await assert.rejects(()=>collect([thought,stop],AbortSignal.abort(new Error('cancelled'))),/cancelled/);
});
