const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const KEY=['kp','annotate','batch','v1'].join('-');
const LIB='kp-annotate-library-v1';
const image='data:image/png;base64,AAAA';
const legacy={schemaVersion:1,batchId:'legacy',nextId:2,annotations:[{id:1,mode:'point',category:'视觉',text:'原话',url:'https://example.com',pageKey:'https://example.com/',title:'页面',elements:[],rect:{x:5,y:6,width:50,height:40},viewport:{width:1440,height:1000},shot:'shots/001.png',refs:[]}]};
function setup(initial=legacy){
 const state=initial?{[KEY]:JSON.stringify(initial)}:{};const pictures=new Map(initial?[[legacy.annotations[0].shot,image]]:[]);let fail=false;
 const event={addListener(){},removeListener(){}};
 const chrome={storage:{local:{get:async key=>typeof key==='string'?{[key]:state[key]}:{...state},set:async values=>{if(fail){fail=false;throw Error('quota');}Object.assign(state,structuredClone(values));}}},runtime:{id:'test',onMessage:event,getURL:p=>'chrome-extension://test/'+p},action:{onClicked:event},tabs:{onActivated:event,onUpdated:event,onRemoved:event}};
 const c=vm.createContext({chrome,crypto:require('node:crypto').webcrypto,URL,setTimeout,Date,AbortSignal,fetch,console});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8'),c);
 c.memoryAssets=async(mode,entries)=>{const out={};for(const [key,value] of entries){if(mode==='readonly')out[key]=pictures.get(key);else if(value===null)pictures.delete(key);else pictures.set(key,value);}return out;};
 vm.runInContext('assets=memoryAssets;globalThis.subject={libraryLoad,catalog,manage,commit,getBatchAsset,pruneBatchAssets,snapshot};',c);
 return {state,pictures,subject:c.subject,failNext:()=>{fail=true;}};
}
test('旧批迁移幂等，保留原始图片并建立批次图片隔离',async()=>{
 const {state,pictures,subject:s}=setup();const raw=await s.libraryLoad();assert.deepEqual(JSON.parse(raw).annotations,legacy.annotations);
 assert(state[LIB]);assert.equal(await s.getBatchAsset('legacy','shots/001.png'),image);assert.equal(pictures.get('shots/001.png'),image);
 await s.libraryLoad();assert.equal((await s.catalog()).batches.length,1);
});
test('迁移缺图或元数据写失败保留旧数据，重试可收敛',async()=>{
 const a=setup();a.pictures.clear();await assert.rejects(a.subject.libraryLoad(),/缺少图片/);assert.equal(a.state[KEY],JSON.stringify(legacy));assert(!a.state[LIB]);
 const b=setup();b.failNext();await assert.rejects(b.subject.libraryLoad(),/quota/);assert.equal(b.state[KEY],JSON.stringify(legacy));assert(!b.state[LIB]);await b.subject.libraryLoad();assert.equal((await b.subject.catalog()).batches.length,1);
});
test('归档并新建不要求导出，历史明细与图片可找回',async()=>{
 const {subject:s}=setup();const expected=await s.libraryLoad();const raw=await s.manage({action:'archive-new',expected,name:'第二轮'});const next=JSON.parse(raw);assert.equal(next.annotations.length,0);assert.equal(next.nextId,1);
 const list=await s.catalog();assert.equal(list.batches.length,2);assert.equal(list.batches.find(b=>b.batchId==='legacy').status,'archived');
 const restored=JSON.parse(await s.manage({action:'select',batchId:'legacy',expected:raw}));assert.equal(restored.annotations[0].text,'原话');assert.equal(await s.getBatchAsset('legacy','shots/001.png'),image);
});
test('不同项目两批次同名截图读写与清理均隔离',async()=>{
 const {subject:s}=setup();let raw=await s.libraryLoad();raw=await s.manage({action:'new-project',name:'另一个项目',batchName:'首轮',expected:raw});const b=JSON.parse(raw);assert.notEqual(b.projectId,'default');
 b.nextId=2;b.annotations=structuredClone(legacy.annotations);raw=await s.commit({batch:b,expected:raw,assets:{'shots/001.png':'data:image/png;base64,BBBB'}});
 assert.equal(await s.getBatchAsset('legacy','shots/001.png'),image);assert.equal(await s.getBatchAsset(b.batchId,'shots/001.png'),'data:image/png;base64,BBBB');
 b.annotations=[];raw=await s.commit({batch:b,expected:raw,assets:{}});await s.pruneBatchAssets({batchId:b.batchId,expected:raw,keys:['shots/001.png']});assert.equal(await s.getBatchAsset('legacy','shots/001.png'),image);
});
test('批次A→B→A拒绝旧快照，阻止草稿静默写进其他批次',async()=>{
 const {subject:s}=setup();const old=await s.libraryLoad();let raw=await s.manage({action:'new-batch',name:'B',expected:old});raw=await s.manage({action:'select',batchId:'legacy',expected:raw});assert.notEqual(raw,old);
 await assert.rejects(s.commit({batch:JSON.parse(old),expected:old,assets:{}}),/其他标签页/);
});
test('同名已存图片不可覆盖，元数据失败时图片回滚',async()=>{
 const {subject:s,failNext}=setup();let raw=await s.libraryLoad();const batch=JSON.parse(raw);
 await assert.rejects(s.commit({batch,expected:raw,assets:{'shots/001.png':'data:image/png;base64,CCCC'}}),/覆盖/);
 batch.nextId=3;batch.annotations.push({...batch.annotations[0],id:2,shot:'shots/002.png'});failNext();await assert.rejects(s.commit({batch,expected:raw,assets:{'shots/002.png':image}}),/quota/);assert.equal(await s.snapshot(),raw);assert.equal(await s.getBatchAsset('legacy','shots/002.png'),null);
});
