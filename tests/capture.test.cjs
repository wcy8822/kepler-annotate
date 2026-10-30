const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function event(){const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...a)=>listeners.forEach(f=>f(...a)),get size(){return listeners.size;}};}
function setup(){
 const tab={id:7,windowId:3,url:'https://example.com/'};
 const tabs={onActivated:event(),onUpdated:event(),onRemoved:event(),get:async()=>tab,query:async()=>[tab],captureVisibleTab:async()=> 'data:image/png;base64,AAAA'};
 const calls=[];
 const chrome={tabs,runtime:{onMessage:event(),getURL:p=>'chrome-extension://test/'+p},action:{onClicked:event(),setBadgeText:async()=>{},setTitle:async()=>{}},scripting:{executeScript:async options=>{calls.push(options);return [{documentId:'document-original',result:tab.url}];}}};
 const context=vm.createContext({chrome,fetch:async()=>({text:async()=>'.tool{}'}),setTimeout,Date,URL,AbortSignal});
 vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../service-worker.js'),'utf8')+'\nglobalThis.subject={capture,inject};',context);
 return {tab,tabs,calls,subject:context.subject};
}
test('原生截图在保持同一标签时成功并清理监听器',async()=>{
 const {tab,tabs,subject}=setup();assert.match(await subject.capture({tab,url:tab.url,documentId:'document-original'}),/^data:image/);
 for(const e of [tabs.onActivated,tabs.onUpdated,tabs.onRemoved])assert.equal(e.size,0);
});
test('截图期间 A→B→A 仍拒绝返回其他站点图片',async()=>{
 const {tab,tabs,subject}=setup();tabs.captureVisibleTab=async()=>{tabs.onActivated.emit({windowId:3,tabId:8});tabs.onActivated.emit({windowId:3,tabId:7});return 'foreign-image';};
 await assert.rejects(subject.capture({tab,url:tab.url,documentId:'document-original'}),/页面已变化/);assert.equal(tabs.onActivated.size,0);
});
test('同 URL 页面重载也拒绝截图',async()=>{
 const {tab,tabs,subject}=setup();tabs.captureVisibleTab=async()=>{tabs.onUpdated.emit(7,{status:'loading'});return 'stale-image';};
 await assert.rejects(subject.capture({tab,url:tab.url,documentId:'document-original'}),/页面已变化/);
});
test('其他窗口切换标签不干扰当前窗口截图',async()=>{
 const {tab,tabs,subject}=setup();tabs.captureVisibleTab=async()=>{tabs.onActivated.emit({windowId:9,tabId:12});return 'current-image';};
 assert.equal(await subject.capture({tab,url:tab.url,documentId:'document-original'}),'current-image');
});
test('功能脚本绑定首次 CSS 注入的同一文档',async()=>{
 const {tab,calls,subject}=setup();await subject.inject(tab);assert.equal(calls.length,2);
 assert.deepEqual(Array.from(calls[1].target.documentIds),['document-original']);
 assert.equal(calls[1].target.tabId,tab.id);
});
test('站内 hash 路由跳转后使用当前文档地址，保留截图校验',async()=>{
 const {tab,subject}=setup();tab.url='https://example.com/#page=task';
 assert.match(await subject.capture({tab,url:'https://example.com/#page=home',documentId:'document-original'}),/^data:image/);
});
