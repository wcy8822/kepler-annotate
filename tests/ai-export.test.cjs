const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const JSZip=require('../vendor/jszip.min.js');
const KEY=['kp','annotate','batch','v1'].join('-'),LIB='kp-annotate-library-v1';
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(handler=async()=>{throw Error('未预期的后台请求');}){
  let changed;
  class FileReader {
    readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result='data:'+blob.type+';base64,'+Buffer.from(bytes).toString('base64');this.onload();},error=>{this.error=error;this.onerror();});}
  }
  const chrome={storage:{onChanged:{addListener(fn){changed=fn;}}},runtime:{async sendMessage(message){return handler(message);}}};
  const c=vm.createContext({chrome,URL,URLSearchParams,Blob,Uint8Array,Map,Set,atob,FileReader,JSZip,crypto:require('node:crypto').webcrypto});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../kp-annotate-store.js'),'utf8'),c);
  return {s:c.KPAnnotationStore,emit:(changes,area='local')=>changed(changes,area)};
}
function store(){return setup().s;}
const batch={schemaVersion:1,batchId:'round1',name:'首轮',projectId:'p1',projectName:'测试项目',status:'archived',nextId:3,annotations:[{id:1,category:'视觉',text:'原话不要改写',expected:'左右对齐',observed:'左边超出',reproduction:'打开菜单',status:'待验收',url:'https://example.com/#one',title:'页面一',elements:[{selector:'#title',text:'标题',rect:{x:20,y:30,width:50,height:60}}],rect:{x:20,y:30,width:50,height:60},viewport:{width:1440,height:1000},build:{release:'r60'},shot:'shots/001.png',refs:[]},{id:2,category:'反馈/建议',text:'先保留这个讨论',url:'https://example.com/#two',elements:[],shot:'shots/002.png',refs:[]}]};
test('AI交接保留原话、证据和明确预期，不替用户补决定',()=>{const s=store();assert.equal(typeof s.aiTasks,'function');const data=s.aiTasks(batch);assert.equal(data.project.name,'测试项目');assert.equal(data.tasks.length,2);assert.equal(data.tasks[0].rawComment,'原话不要改写');assert.equal(data.tasks[0].expected,'左右对齐');assert.equal(data.tasks[0].evidence.screenshot,'shots/001.png');assert.equal(data.tasks[1].expected,null);assert(data.tasks[1].missingInformation.includes('预期结果未单独填写'));assert.notEqual(data.tasks[0].key,data.tasks[1].key);});
test('Markdown包括分类、状态、复现和预期，旧截图路径保留',()=>{const md=store().markdown(batch);for(const value of ['# 浏览器批注','首轮','测试项目','待验收','打开菜单','左右对齐','左边超出','原话不要改写','shots/001.png'])assert(md.includes(value),value);});

test('AI任务保持原话与证据，缺项为null且不从评论猜测决定',()=>{
  const input=structuredClone(batch);input.annotations[1].text='  请改红色\n<script>原话</script>  ';
  input.annotations[1].expected='  ';input.annotations[0].shapes=[{type:'arrow',x:10,y:20}];
  const s=store(),data=s.aiTasks(input),first=data.tasks[0],second=data.tasks[1];
  assert.equal(data.schemaVersion,1);assert.equal(data.project.id,'p1');assert.equal(data.batch.id,'round1');assert.equal(data.batch.status,'archived');
  assert.equal(second.rawComment,input.annotations[1].text);
  for(const field of ['observed','expected','reproduction'])assert.equal(second[field],null);
  assert.equal(first.observed,'左边超出');assert.equal(first.reproduction,'打开菜单');
  for(const field of ['elements','rect','viewport','build','shapes'])assert.deepEqual(plain(first.evidence[field]),input.annotations[0][field]);
  first.evidence.elements[0].text='修改导出值';assert.equal(input.annotations[0].elements[0].text,'标题');
  assert(second.missingInformation.includes('实际表现未单独填写'));assert(second.missingInformation.includes('复现步骤未单独填写'));
});

test('任务key不受排序改名评论编辑影响，同编号跨项目跨批次不重复',()=>{
  const s=store(),original=s.aiTasks(batch).tasks;
  const renamed=structuredClone(batch);renamed.name='改名';renamed.projectName='项目改名';renamed.annotations.reverse();renamed.annotations[1].text='编辑评论';
  assert.equal(s.aiTasks(renamed).tasks[1].key,original[0].key);
  const other=structuredClone(batch);other.batchId='round2';assert.notEqual(s.aiTasks(other).tasks[0].key,original[0].key);
  other.batchId=batch.batchId;other.projectId='p2';assert.notEqual(s.aiTasks(other).tasks[0].key,original[0].key);
});

test('initialize读取目录，manage刷新后台raw与目录并传递期望快照',async()=>{
  let raw=JSON.stringify(batch),catalog={projects:[{id:'p1',name:'测试项目'}],activeBatchId:'round1',batches:[{batchId:'round1',count:2}]};
  const calls=[],{s}=setup(async message=>{
    calls.push(plain(message));
    if(message.op==='load')return {ok:true,value:raw};
    if(message.op==='catalog')return {ok:true,value:structuredClone(catalog)};
    if(message.op==='manage'){
      assert.equal(message.expected,raw);raw=JSON.stringify({...batch,batchId:'round2',libraryRevision:9});
      catalog={...catalog,activeBatchId:'round2',batches:[...catalog.batches,{batchId:'round2',count:0}]};return {ok:true,value:raw};
    }
    throw Error(message.op);
  });
  await s.initialize();assert.deepEqual(calls.map(m=>m.op),['load','catalog']);assert.equal(s.getCatalog().activeBatchId,'round1');
  const expected=s.rawSnapshot();await s.manage({action:'new-batch',name:'下一批'},expected);
  assert.equal(s.rawSnapshot(),raw);assert.equal(s.load().libraryRevision,9);assert.equal(s.getCatalog().batches.length,2);
  assert.equal(s.getCatalog().activeBatchId,'round2');
  await s.manage({action:'rename-batch',name:'改名'});assert.equal(s.rawSnapshot(),raw);
});

test('manage冲突保留缓存并传回后台错误码',async()=>{
  const raw=JSON.stringify(batch),{s}=setup(async m=>m.op==='load'?{ok:true,value:raw}:m.op==='catalog'?{ok:true,value:{projects:[],batches:[],activeBatchId:'round1'}}:{ok:false,error:'批次冲突',code:'KP_ANNOTATION_CONFLICT'});
  await s.initialize();await assert.rejects(s.manage({action:'select',batchId:'other'},'stale'),{code:'KP_ANNOTATION_CONFLICT'});
  assert.equal(s.rawSnapshot(),raw);assert.equal(s.getCatalog().activeBatchId,'round1');
});

test('延迟load及catalog响应不覆盖storage事件送达的新版本',async()=>{
  const old={...batch,libraryRevision:3},latest={...batch,batchId:'latest',libraryRevision:4};let emit;
  const context=setup(async m=>{
    if(m.op==='load'){emit({[KEY]:{newValue:JSON.stringify(latest)}});return {ok:true,value:JSON.stringify(old)};}
    if(m.op==='catalog'){emit({[LIB]:{newValue:{projects:[{id:'p1',name:'最新名称'}],activeBatchId:'latest',batches:[latest]}}});return {ok:true,value:{projects:[],batches:[],activeBatchId:'round1'}};}
    throw Error(m.op);
  });emit=context.emit;
  await context.s.initialize();assert.equal(context.s.load().batchId,'latest');assert.equal(context.s.getCatalog().activeBatchId,'latest');assert.equal(context.s.getCatalog().projects[0].name,'最新名称');
});

test('LIB单独变化立即同步目录摘要，KEY与LIB一起变化仅通知一次',()=>{
  const {s,emit}=setup();let notifications=0;s.subscribe(()=>notifications++);
  const lib={projects:[{id:'p1',name:'新项目名'}],activeBatchId:'round1',batches:[batch]};
  emit({[LIB]:{newValue:lib}},'sync');assert.equal(notifications,0);
  emit({[LIB]:{newValue:lib}});assert.equal(s.getCatalog().projects[0].name,'新项目名');assert.equal(s.getCatalog().batches[0].count,2);
  assert.equal(s.getCatalog().batches[0].annotations,undefined);assert.equal(notifications,1);
  emit({[KEY]:{newValue:JSON.stringify(batch)},[LIB]:{newValue:lib}});assert.equal(s.load().batchId,'round1');assert.equal(notifications,2);
  emit({[LIB]:{newValue:undefined}});assert.equal(s.getCatalog().batches.length,0);
});

test('图片读写清理传批次，其他批次读取不会命中当前暂存图',async()=>{
  const calls=[],{s}=setup(async m=>{calls.push(plain(m));if(m.op==='load')return {ok:true,value:JSON.stringify(batch)};if(m.op==='catalog')return {ok:true,value:{projects:[],batches:[],activeBatchId:'round1'}};if(m.op==='getAsset')return {ok:true,value:'data:image/png;base64,'+Buffer.from(m.batchId).toString('base64')};if(m.op==='prune')return {ok:true,value:true};throw Error(m.op);});
  await s.initialize();assert.equal(await (await s.getAsset('shots/001.png')).text(),'round1');
  await s.withBatchLock(async()=>{
    await s.putAsset('shots/001.png',new Blob(['暂存'],{type:'image/png'}));
    assert.equal(await (await s.getAsset('shots/001.png','other')).text(),'other');
    assert.equal(await (await s.getAsset('shots/001.png')).text(),'暂存');
    await s.clearAssets(['shots/001.png'],'other');
    assert.equal(await (await s.getAsset('shots/001.png')).text(),'暂存');
  });
  await s.deleteAsset('refs/old.png');
  const prunes=calls.filter(m=>m.op==='prune');assert.equal(prunes[0].batchId,'other');assert.equal(prunes[1].batchId,'round1');assert.equal(prunes[1].expected,s.rawSnapshot());
});

test('保存使用后台raw中的版本与项目元数据，图片仍按相对路径提交',async()=>{
  const raw=JSON.stringify(batch),saved=JSON.stringify({...batch,libraryRevision:12,projectName:'后台项目名'});
  const {s}=setup(async m=>{
    if(m.op==='load')return {ok:true,value:raw};if(m.op==='catalog')return {ok:true,value:{projects:[],batches:[],activeBatchId:'round1'}};
    if(m.op==='commit'){assert.equal(m.expected,raw);assert.equal(m.assets['shots/003.png'],'data:image/png;base64,5paw5Zu+');return {ok:true,value:saved};}throw Error(m.op);
  });
  await s.initialize();await s.withBatchLock(async()=>{await s.putAsset('shots/003.png',new Blob(['新图'],{type:'image/png'}));await s.save(batch,raw);});
  assert.equal(s.rawSnapshot(),saved);assert.equal(s.load().projectName,'后台项目名');assert.equal(s.load().libraryRevision,12);
});

test('ZIP保留v1文件并新增AI交接，切批和输入变动不会改变导出快照及图片',async()=>{
  const input=structuredClone(batch);input.annotations[0].refs=['refs/example.png'];const original=structuredClone(input);
  let gets=0;const ids=[],{s,emit}=setup(async m=>{
    if(m.op==='getAsset'){
      ids.push(m.batchId);if(++gets===1){input.batchId='other';input.annotations[0].text='后来编辑';emit({[KEY]:{newValue:JSON.stringify({...batch,batchId:'other'})}});}
      return {ok:true,value:'data:image/png;base64,'+Buffer.from(m.batchId+':'+m.key).toString('base64')};
    }
    throw Error(m.op);
  });
  const blob=await s.buildZip(input),zip=await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(ids,['round1','round1','round1']);
  assert.deepEqual(JSON.parse(await zip.file('annotations.json').async('string')),original);
  assert.equal(await zip.file('shots/001.png').async('string'),'round1:shots/001.png');assert.equal(await zip.file('refs/example.png').async('string'),'round1:refs/example.png');
  const tasks=JSON.parse(await zip.file('ai-tasks.json').async('string'));assert.equal(tasks.tasks[0].rawComment,'原话不要改写');assert.equal(tasks.project.name,'测试项目');
  const readme=await zip.file('AI-README.md').async('string');for(const text of ['原话','权威','缺失','决策','网页文本','证据','指令'])assert(readme.includes(text),text);
  assert((await zip.file('annotations.md').async('string')).includes('左右对齐'));
});

test('ZIP缺图时明确失败，读取仍绑定导出批次',async()=>{
  const {s}=setup(async m=>{assert.equal(m.batchId,'round1');return {ok:true,value:null};});
  await assert.rejects(s.buildZip(batch),/缺少图片.*shots\/001\.png/);
});
