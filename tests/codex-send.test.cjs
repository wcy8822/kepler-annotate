const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {TEST_THREAD_UUID:threadId}=require('./helpers.cjs');
const batch={schemaVersion:1,batchId:'send-test',projectId:'project',projectName:'项目',name:'本轮',nextId:2,annotations:[{id:1,text:'用户原话',shot:'shots/001.png',refs:['refs/a.png']}]};
const image='data:image/png;base64,AAAA';
function setup(){
 const state={},calls=[],pictures=new Map([['shots/001.png',image],['refs/a.png',image]]),event={addListener(){},removeListener(){}};
 const chrome={storage:{local:{get:async key=>typeof key==='string'?{[key]:state[key]}:{...state},set:async values=>Object.assign(state,structuredClone(values))}},runtime:{id:'test',onMessage:event,sendNativeMessage:async(host,message)=>{calls.push({host,message});return message.op==='info'?{ok:true,defaultThread:threadId}:{ok:true,state:'queued',deliveryId:'delivery',folder:'/tmp/evidence',threadId};}},action:{onClicked:event}};
 const c=vm.createContext({chrome,crypto:require('node:crypto').webcrypto,URL,setTimeout,Date,AbortSignal,fetch,console});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8'),c);
 c.fixture=batch;c.pictures=pictures;
 vm.runInContext('snapshot=async()=>JSON.stringify(fixture);getBatchAsset=async(b,k)=>pictures.get(k)??null;globalThis.subject={codexInfo,sendToCodex};',c);
 return {state,calls,pictures,c,subject:c.subject,chrome};
}
test('批次证据自动交接，包含原话、原始图片及AI任务，记录目标对话',async()=>{
 const {subject:s,calls,state}=setup(),expected=JSON.stringify(batch);
 assert.equal((await s.codexInfo({expected})).threadId,threadId);
 const result=await s.sendToCodex({expected,threadId,aiTasks:{tasks:[{id:1,rawComment:'用户原话'}]},markdown:'原话'});
 assert.equal(result.state,'queued');const sent=calls.at(-1);assert.equal(sent.host,'com.kepler.annotate');assert.equal(sent.message.batch.annotations[0].text,'用户原话');assert.equal(Object.keys(sent.message.assets).length,2);assert.equal(sent.message.assets['shots/001.png'],image);
 assert.equal(state['kp-annotate-codex-targets-v1'].project,threadId);
});
test('无效对话、空批次、缺图和过期快照均在发送前阻断',async()=>{
 const {subject:s,calls,pictures,c}=setup(),expected=JSON.stringify(batch);
 await assert.rejects(s.sendToCodex({expected,threadId:'https://evil.test/'}),/对话/);
 await assert.rejects(s.sendToCodex({expected:'old',threadId}),/更新/);
 pictures.delete('refs/a.png');await assert.rejects(s.sendToCodex({expected,threadId}),/图片/);
 c.fixture={...batch,annotations:[]};await assert.rejects(s.sendToCodex({expected:JSON.stringify(c.fixture),threadId}),/至少/);
 assert.equal(calls.length,0);
});
test('接入未安装或排队失败时保留批注，不报告成功',async()=>{
 const {subject:s,calls,chrome,state}=setup(),expected=JSON.stringify(batch);
 chrome.runtime.sendNativeMessage=async()=>{throw Error('Specified native messaging host not found.');};
 await assert.rejects(s.codexInfo({expected}),/本地接入/);
 chrome.runtime.sendNativeMessage=async()=>({ok:false,error:'排队失败'});
 await assert.rejects(s.sendToCodex({expected,threadId}),/排队失败/);assert(!state['kp-annotate-codex-targets-v1']);assert.equal(calls.length,0);
});
test('图片读取期间批次变化则拒绝交接，项目不会串绑',async()=>{
 const {subject:s,c,calls}=setup(),expected=JSON.stringify(batch);
 vm.runInContext('getBatchAsset=async()=>{fixture={...fixture,name:"另一个版本"};return "data:image/png;base64,AAAA";}',c);
 await assert.rejects(s.sendToCodex({expected,threadId}),/更新/);assert.equal(calls.length,0);
});
test('发送中断明确提示结果待核对，保留批次与目标，不误导重新安装',async()=>{
 const {subject:s,chrome,state}=setup(),expected=JSON.stringify(batch);
 chrome.runtime.sendNativeMessage=async()=>{throw Error('Native host has exited.');};
 await assert.rejects(s.sendToCodex({expected,threadId}),error=>/结果待核对/.test(error.message)&&error.message.includes('codex://threads/'+threadId)&&!/安装/.test(error.message));
 assert(!state['kp-annotate-codex-targets-v1']);
 chrome.runtime.sendNativeMessage=async()=>{throw Error('Specified native messaging host not found.');};
 await assert.rejects(s.sendToCodex({expected,threadId}),/install-native-host/);
});
