'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const KEY=['kp','annotate','batch','v1'].join('-'),LIB='kp-annotate-library-v1',SYNC='kp-annotate-project-sync-v1';
const image='data:image/png;base64,AAAA',otherImage='data:image/png;base64,BBBB';
const sender={id:'test',tab:{id:1},frameId:0,url:'https://example.com/'};
const annotation={id:1,text:'用户原话',url:'https://example.com/',pageKey:'https://example.com/',title:'页面',category:'视觉',status:'未处理',elements:[],shot:'shots/001.png',refs:['refs/a.png']};
function setup(shared){
 const state=shared?.state||{},pictures=shared?.pictures||new Map(),calls=[],bindings=shared?.bindings||new Map(),copies=shared?.copies||new Map();
 const listeners=[],event={addListener(){},removeListener(){}};let failure=null,hook=null,statusFailure=false;
 const chrome={runtime:{id:'test',onMessage:event},action:{onClicked:event},storage:{onChanged:{addListener:fn=>listeners.push(fn)},local:{get:async key=>({[key]:structuredClone(state[key])}),set:async values=>{if(statusFailure&&Object.hasOwn(values,SYNC))throw Error('status quota');const changes={};for(const [key,value]of Object.entries(values)){changes[key]={newValue:structuredClone(value)};state[key]=structuredClone(value);}for(const fn of listeners)fn(changes,'local');}}}};
 chrome.runtime.sendNativeMessage=async(host,message)=>{
  assert.equal(host,'com.kepler.annotate');calls.push(structuredClone(message));if(hook)await hook(message);if(failure)throw Error(failure);
  const projectId=message.projectId||message.batch?.projectId;
  if(message.op==='project-info')return {ok:true,binding:bindings.get(projectId)||null};
  if(message.op==='project-bind'){const binding={projectId,projectName:message.projectName,projectRoot:message.projectRoot};bindings.set(projectId,binding);return {ok:true,binding};}
  if(message.op==='project-sync'){
   const binding=bindings.get(projectId);if(!binding)return {ok:true,bound:false};
   const {batch,assets}=message;
   for(const a of batch.annotations)for(const p of [a.shot,...a.refs])assert(assets[p],'native收到完整图片：'+p);
   const revision=JSON.stringify([batch.name,batch.status,batch.projectName,batch.annotations]),items=batch.annotations.map(a=>({id:a.id,revision:JSON.stringify(a),result:null}));
   const result={ok:true,bound:true,projectRoot:binding.projectRoot,batchId:batch.batchId,revision,items};copies.set(projectId+':'+batch.batchId,{message:structuredClone(message),result});return structuredClone(result);
  }
  if(message.op==='project-read')return structuredClone(copies.get(projectId+':'+message.batchId).result);
  throw Error('本测试禁止发送或queue：'+message.op);
 };
 const c=vm.createContext({chrome,crypto:require('node:crypto').webcrypto,URL,URLSearchParams,setTimeout,Date,AbortSignal,fetch,console});
 c.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),c);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8'),c);
 c.memoryAssets=async(mode,entries)=>{const result={};for(const [key,value]of entries){if(mode==='readonly')result[key]=pictures.get(key);else if(value===null)pictures.delete(key);else pictures.set(key,value);}return result;};
 vm.runInContext('assets=memoryAssets;globalThis.subject={handle,snapshot};',c);
 const rpc=(op,data={})=>c.subject.handle({op,...data},sender),raw=()=>c.subject.snapshot();
 async function save(items=[annotation],assets={'shots/001.png':image,'refs/a.png':image}){const expected=await raw(),batch=JSON.parse(expected);batch.annotations=structuredClone(items);batch.nextId=Math.max(batch.nextId,...items.map(a=>a.id+1));return rpc('commit',{expected,batch,assets});}
 return {state,pictures,calls,bindings,copies,c,rpc,raw,save,fail:value=>{failure=value;},hook:fn=>{hook=fn;},statusFail:()=>{statusFailure=true;}};
}
async function prepared(){const s=setup();await s.rpc('load');await s.save();return s;}
test('项目RPC从当前快照取身份，绑定后同步原话、helpers及全部图片',async()=>{
 const s=await prepared(),expected=await s.raw();const info=await s.rpc('project-info',{expected,projectId:'伪造'});assert.equal(info.binding,null);
 await s.rpc('project-bind',{expected,projectId:'伪造',projectRoot:'/tmp/project-a'});
 const sent=s.calls.filter(c=>c.op==='project-sync').at(-1);assert.equal(sent.batch.projectId,'default');assert.equal(sent.aiTasks.tasks[0].rawComment,'用户原话');assert(sent.markdown.includes('用户原话'));assert.equal(sent.assets['shots/001.png'],image);assert.equal(sent.assets['refs/a.png'],image);
 const current=await s.rpc('project-info',{expected});assert.equal(current.binding.projectRoot,'/tmp/project-a');assert.equal(current.sync.state,'synced');assert.equal(await s.raw(),expected);
});
test('已绑定项目自动同步增改删，commit返回原raw，状态metadata不触发循环',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});s.calls.length=0;
 let raw=await s.save([{...annotation,text:'修改原话'},{...annotation,id:2,shot:'shots/002.png'}],{'shots/002.png':otherImage});assert.equal(raw,await s.raw());assert.equal(s.calls.filter(c=>c.op==='project-sync').at(-1).batch.annotations.length,2);
 await s.save([{...annotation,text:'只剩一条'}],{});assert.equal(s.calls.filter(c=>c.op==='project-sync').at(-1).batch.annotations.length,1);
 await s.save([],{});assert.deepEqual(s.calls.filter(c=>c.op==='project-sync').at(-1).batch.annotations,[]);assert.equal(s.calls.filter(c=>c.op==='project-sync').length,3);assert.equal(s.state[SYNC].default.state,'synced');
});
test('归档旧批与新批同时同步，重新绑定补齐全部历史批次及同名图片',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});const first=JSON.parse(await s.raw()).batchId;s.calls.length=0;
 const raw=await s.rpc('manage',{action:'archive-new',name:'第二批',expected:await s.raw()}),next=JSON.parse(raw);const sent=s.calls.filter(c=>c.op==='project-sync');assert.equal(sent.length,2);assert.equal(sent.find(c=>c.batch.batchId===first).batch.status,'archived');assert.equal(sent.find(c=>c.batch.batchId===next.batchId).batch.annotations.length,0);
 await s.save([annotation],{'shots/001.png':otherImage,'refs/a.png':otherImage});s.calls.length=0;await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-b'});const copies=s.calls.filter(c=>c.op==='project-sync');assert.equal(copies.length,2);assert.equal(copies.find(c=>c.batch.batchId===first).assets['shots/001.png'],image);assert.equal(copies.find(c=>c.batch.batchId===next.batchId).assets['shots/001.png'],otherImage);assert.equal(s.state[SYNC].default.projectRoot,'/tmp/project-b');
});
test('不同项目不自动绑定、不串图，SW重载后仍按真实binding同步',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});const old=JSON.parse(await s.raw());
 await s.rpc('manage',{action:'new-project',name:'B',expected:await s.raw()});const b=JSON.parse(await s.raw());s.calls.length=0;await s.save([annotation],{'shots/001.png':otherImage,'refs/a.png':otherImage});assert.equal(s.calls.filter(c=>c.op==='project-sync').length,0);assert.equal(s.state[SYNC][b.projectId].state,'unbound');assert.equal(s.bindings.has(b.projectId),false);
 await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-b'});const reloaded=setup(s);await reloaded.save([{...annotation,text:'重载后'}],{});const sent=reloaded.calls.filter(c=>c.op==='project-sync');assert.equal(sent.length,1);assert.equal(sent[0].batch.projectId,b.projectId);assert.equal(sent[0].assets['shots/001.png'],otherImage);assert.equal(s.copies.get('default:'+old.batchId).message.assets['shots/001.png'],image);
});
test('过期快照和不可信sender在native调用前拒绝，异步读取中变化也拒绝',async()=>{
 const s=await prepared(),expected=await s.raw();s.calls.length=0;
 for(const op of ['project-info','project-bind','project-sync','project-read']){await assert.rejects(s.rpc(op,{expected:'old',projectRoot:'/tmp/project-a'}),/其他标签页/);await assert.rejects(s.c.subject.handle({op,expected},{...sender,frameId:1}),/来源/);}assert.equal(s.calls.length,0);
 s.hook(async message=>{if(message.op==='project-info'){const changed=JSON.parse(s.state[KEY]);changed.name='外部变化';s.state[KEY]=JSON.stringify(changed);}});await assert.rejects(s.rpc('project-info',{expected}),/其他标签页/);
});
test('native故障与状态写失败均保留浏览器commit/manage成功，不回滚图片',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});s.fail('Native host has exited.');const raw=await s.save([{...annotation,text:'离线修改'}],{});assert.equal(JSON.parse(raw).annotations[0].text,'离线修改');assert.equal(s.state[SYNC].default.state,'error');assert.match(s.state[SYNC].default.message,/已保留|浏览器/);
 s.statusFail();const next=await s.rpc('manage',{action:'archive-new',name:'离线下一批',expected:raw});assert.equal(JSON.parse(next).name,'离线下一批');assert.equal(s.pictures.get('batches/'+JSON.parse(raw).batchId+'/shots/001.png'),image);
 const unknown=await prepared();unknown.fail('Specified native messaging host not found.');assert.equal(JSON.parse(await unknown.save([],{})).annotations.length,0);
});
test('缺图阻断native同步，read先同步当前版本且返回该版本AI结果',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});const batch=JSON.parse(await s.raw());const key='batches/'+batch.batchId+'/shots/001.png';s.pictures.delete(key);s.calls.length=0;
 await assert.rejects(s.rpc('project-sync',{expected:await s.raw()}),/图片/);assert.equal(s.calls.filter(c=>c.op==='project-sync').length,0);s.pictures.set(key,image);
 await s.save([{...annotation,text:'最新原话'}],{});s.copies.clear();s.calls.length=0;const result=await s.rpc('project-read',{expected:await s.raw()});const ops=s.calls.map(c=>c.op);assert(ops.indexOf('project-sync')<ops.indexOf('project-read'));assert.equal(result.items[0].revision,JSON.stringify({...annotation,text:'最新原话'}));assert.equal(result.items[0].result,null);
});
test('read拒绝过期revision及读取失败，保留浏览器并记录error',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});const expected=await s.raw();s.hook(async message=>{if(message.op==='project-read')s.copies.get(message.projectId+':'+message.batchId).result.items[0].revision='旧版本';});await assert.rejects(s.rpc('project-read',{expected}),/版本/);assert.equal(s.state[SYNC].default.state,'error');assert.equal(await s.raw(),expected);
 s.hook(async message=>{if(message.op==='project-read')throw Error('结果读取失败');});await assert.rejects(s.rpc('project-read',{expected}),/结果读取失败/);assert.equal(await s.raw(),expected);
});
test('图片读取后expected变化阻断发送，长同步与后续manage严格串行',async()=>{
 const s=await prepared();await s.rpc('project-bind',{expected:await s.raw(),projectRoot:'/tmp/project-a'});s.calls.length=0;const expected=await s.raw();
 s.c.tamper=()=>{s.state[KEY]=JSON.stringify({...JSON.parse(expected),name:'外部更新'});};vm.runInContext('const originalAssets=assets;assets=async(mode,entries)=>{const result=await originalAssets(mode,entries);if(mode==="readonly")tamper();return result;};',s.c);
 await assert.rejects(s.rpc('project-sync',{expected}),/其他标签页/);assert.equal(s.calls.filter(c=>c.op==='project-sync').length,0);
 const t=await prepared();await t.rpc('project-bind',{expected:await t.raw(),projectRoot:'/tmp/project-a'});const before=await t.raw();let release,entered,once=false;const ready=new Promise(resolve=>{entered=resolve;});
 t.hook(async message=>{if(message.op==='project-sync'&&!once){once=true;entered();await new Promise(resolve=>{release=resolve;});}});
 const syncing=t.rpc('project-sync',{expected:before});await ready;const saving=t.rpc('manage',{action:'rename-batch',name:'排队后的修改',expected:before});await Promise.resolve();assert.equal(await t.raw(),before);release();await syncing;assert.equal(JSON.parse(await saving).name,'排队后的修改');
});
