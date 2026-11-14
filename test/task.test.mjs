import test from 'node:test';import assert from 'node:assert/strict';
import {taskState,taskAnchor,finalizationMessages} from '../lib/task.mjs';
const human=(seq,text)=>({seq,type:'user/message',data:{role:'user',source:{kind:'user'},content:[{type:'text',text}]}});
const call=(seq,id)=>({seq,type:'tool/call',data:{callId:id,name:'web_fetch',arguments:'{"url":"https://example.com/rank"}'}});
const result=(seq,id,text='server error')=>({seq,type:'tool/result',data:{message:{toolCallId:id,isError:true,content:[{type:'text',text}]}}});
test('original requests survive summary drift and continue; new task resets episode',()=>{
 const events=[human(1,'Find model rankings from a few sites.'),{seq:2,type:'user/message',data:{source:{kind:'compact-checkpoint'},content:[{type:'text',text:'Goal: Inventory unrelated directories. Constraints: seven sections.'}]}},human(3,'继续')];
 const state=taskState(events);assert.match(taskAnchor(state).content[0].text,/Find model rankings/);assert.doesNotMatch(taskAnchor(state).content[0].text,/Inventory/);
 assert.equal(taskState([...events,human(4,'Now inspect a local directory.')]).startSeq,4);
});
test('three identical failed read-only calls trigger bounded answer; changed results do not',()=>{
 const events=[human(1,'Find rankings.'),call(2,'a'),result(3,'a'),call(4,'b'),result(5,'b'),call(6,'c'),result(7,'c')];
 assert.equal(taskState(events).reason,'repeated-tool-result');
 const changed=structuredClone(events);changed[6].data.message.content[0].text='different error';assert.equal(taskState(changed).reason,null);
 assert.equal(taskState([...events,human(8,'Try this site again.')]).reason,null);
});
test('two blank token-exhausted turns trigger answer, completed response resets',()=>{
 const events=[human(1,'Find rankings.')];for(let n=0;n<2;n++){events.push({seq:2+n*2,type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'synthetic internal notes'}]}}},{seq:3+n*2,type:'turn/end',data:{reason:{kind:'max-tokens'}}});}
 assert.equal(taskState(events).reason,'repeated-empty-output');
 events.push({seq:8,type:'turn/end',data:{reason:{kind:'completed'}}});assert.equal(taskState(events).reason,null);
});
test('bounded answer uses attributed evidence, not hidden reasoning or unrelated goals',()=>{
 const events=[human(1,'Find rankings.'),{seq:2,type:'compaction/summary',data:{summary:[{type:'text',text:'Goal: inventory directories. Completed: Site A ranks X second.'}]}},call(3,'a'),result(4,'a','public evidence '.repeat(5000))];
 const messages=finalizationMessages(taskState(events),events);assert.ok(JSON.stringify(messages).length<14000);assert.match(messages[0].content[0].text,/Do not invent/);assert.doesNotMatch(JSON.stringify(messages),/synthetic internal notes/);
});
test('root request and prior evidence survive multiple follow-up constraints',()=>{
 const events=[human(1,'Find model rankings.'),call(2,'a'),result(3,'a','Source A says Model Z is second.'),human(4,'Use Chinese.'),human(5,'Keep citations.'),human(6,'Answer briefly.')];
 const state=taskState(events);assert.match(taskAnchor(state).content[0].text,/Find model rankings/);
 assert.match(JSON.stringify(finalizationMessages(state,events)),/Model Z is second/);
});
