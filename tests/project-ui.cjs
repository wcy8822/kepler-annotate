'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {chromium,browserExecutablePath,temporaryDirectory,TEST_THREAD_UUID}=require('./helpers.cjs');
const dir=path.resolve(__dirname,'..'),output=temporaryDirectory('project-ui-evidence');
const report={checks:[],output},record=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><html lang="zh"><title>项目增量验收</title><h1>旧文案</h1><p>本地批次查询</p></html>');});
let context,worker,cdp,id;
async function check(name,fn){try{const evidence=await fn();report.checks.push({name,status:'pass',evidence});console.log('PASS',name);}catch(e){report.checks.push({name,status:'fail',error:e.stack});throw e;}finally{record();}}
async function closedUI(page){
 const session=await context.newCDPSession(page);
 async function node(selector){const {root}=await session.send('DOM.getDocument',{depth:-1,pierce:true});function find(n){if(n.nodeName==='DIALOG'&&n.attributes?.some((v,i)=>i%2===0&&v==='class'&&n.attributes[i+1].split(' ').includes('ka-project')))return n;for(const child of [...(n.children||[]),...(n.shadowRoots||[])]){const found=find(child);if(found)return found;}}const dialog=find(root);assert(dialog,'项目弹窗存在');return selector?(await session.send('DOM.querySelector',{nodeId:dialog.nodeId,selector})).nodeId:dialog.nodeId;}
 function view(selector='',hasText){const evaluate=async(fn,arg)=>{const {object}=await session.send('DOM.resolveNode',{nodeId:await node(selector)});try{const r=await session.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(arg){return ('+fn.toString()+')(this,arg);}',arguments:[{value:arg}],returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;}finally{await session.send('Runtime.releaseObject',{objectId:object.objectId});}};const click=async()=>{const r=await evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});await page.mouse.click(r.x,r.y);};return{evaluate,click,locator:s=>view(selector?selector+' '+s:s),textContent:()=>evaluate(el=>el.textContent),fill:async t=>{await click();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(t);},wait:async text=>{await assertEventually(async()=>String(await evaluate(el=>el.textContent)).includes(text));}};}
 return view();
}
async function assertEventually(predicate){for(let n=0;n<100;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}assert.fail('等待界面状态超时');}
async function save(page,text){const ui=page.locator('#kp-annotate-host');await ui.locator('[data-mode=point]').click();await page.locator('h1').click();await ui.locator('[name=text]').fill(text);await ui.locator('[data-action=save]').click();await ui.locator('.ka-editor').waitFor({state:'hidden'});}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'kepler-project-ui-'));
 const chrome=browserExecutablePath();
 context=await chromium.launchPersistentContext(profile,{executablePath:chrome,headless:true,args:['--enable-unsafe-extension-debugging','--disable-extensions-except='+dir,'--load-extension='+dir],viewport:{width:1440,height:1000}});
 worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');id=worker.url().split('/')[2];cdp=await context.browser().newBrowserCDPSession();
 await worker.evaluate(testThread=>{globalThis.projectBinding=null;globalThis.projectPayloads=[];globalThis.projectResults=[];globalThis.projectFail=false;chrome.runtime.sendNativeMessage=async(host,m)=>{if(globalThis.projectFail)throw Error('Native host has exited.');if(m.op==='project-info')return{ok:true,binding:globalThis.projectBinding};if(m.op==='project-bind'){globalThis.projectBinding={projectId:m.projectId,projectName:m.projectName,projectRoot:m.projectRoot};return{ok:true,binding:globalThis.projectBinding};}if(m.op==='project-sync'){if(!globalThis.projectBinding)return{ok:true,bound:false};globalThis.projectPayloads.push(m);return{ok:true,bound:true,projectRoot:globalThis.projectBinding.projectRoot,batchId:m.batch.batchId,revision:'batch-version',items:m.batch.annotations.map(a=>({id:a.id,revision:'item-'+a.text,result:globalThis.projectResults.find(r=>r.id===a.id&&r.revision==='item-'+a.text)||null}))};}if(m.op==='project-read'){const m=globalThis.projectPayloads.at(-1);return{ok:true,binding:globalThis.projectBinding,bound:!!globalThis.projectBinding,projectRoot:globalThis.projectBinding?.projectRoot,batchId:m?.batch.batchId,revision:'batch-version',items:(m?.batch.annotations||[]).map(a=>({id:a.id,revision:'item-'+a.text,result:globalThis.projectResults.find(r=>r.id===a.id&&r.revision==='item-'+a.text)||null}))};}return{ok:true,defaultThread:testThread};};},TEST_THREAD_UUID);
 const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/');const target=(await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false}]})).targetInfos.find(t=>t.url===page.url());await cdp.send('Extensions.triggerAction',{id,targetId:target.targetId});
 const ui=page.locator('#kp-annotate-host');
 await check('项目本地入口保留原项目批次管理',async()=>{await ui.locator('[data-action=project]').waitFor({timeout:2000});await ui.locator('[data-action=list]').first().click();assert.equal(await ui.locator('[name=project]').count(),1);assert.equal(await ui.locator('[name=batch]').count(),1);});
 const dialog=await closedUI(page);
 await check('绑定界面隔离，合成事件不能设置项目路径',async()=>{await ui.locator('[data-action=project]').click();await dialog.wait('绑定');assert.equal(await page.evaluate(()=>!!document.querySelector('#kp-annotate-host').shadowRoot.querySelector('.ka-project')),false);await dialog.locator('input').evaluate(el=>{el.value='/tmp/evil';el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));});await dialog.locator('[data-project=bind]').evaluate(el=>el.click());assert.equal(await worker.evaluate(()=>projectBinding),null);await dialog.locator('[data-project=bind]').click();assert.equal(await worker.evaluate(()=>projectBinding),null);});
 await check('真实绑定同步项目，保存新批注自动同步原话和图片',async()=>{await dialog.locator('input').fill('/tmp/kepler-ui-fixture');await dialog.locator('[data-project=bind]').click();await dialog.wait('已同步');await dialog.locator('[data-project=close]').click();await save(page,'请将标题改为新文案');await assertEventually(()=>worker.evaluate(()=>projectPayloads.some(p=>p.batch.annotations.some(a=>a.text==='请将标题改为新文案'))));const payload=await worker.evaluate(()=>projectPayloads.findLast(p=>p.batch.annotations.length));assert.equal(payload.aiTasks.tasks[0].rawComment,'请将标题改为新文案');assert.match(payload.assets[payload.batch.annotations[0].shot],/^data:image\/png;base64,/);});


 await check('人工决定在原编辑器生成本地历史，拒绝脚本点击且不改 v1 原话',async()=>{
  await ui.locator('[data-edit="1"]').click();
  await ui.locator('.ka-review-draft').waitFor({state:'visible'});
  await ui.locator('.ka-review-state').filter({hasText:'尚未作出决定'}).waitFor();
  await ui.locator('[name=review-proposal]').fill('建议把标题改为更简洁的表达');
  await ui.locator('[data-action=review-adopt]').evaluate(button=>button.click());
  const empty=await worker.evaluate(async()=>((await chrome.storage.local.get('kp-annotate-review-decisions-v1'))['kp-annotate-review-decisions-v1']));
  assert.equal(empty,undefined,'脚本合成点击不产生事件');
  await ui.locator('[data-action=review-reject]').click();
  await ui.locator('.ka-review-state').filter({hasText:'已拒绝草稿'}).waitFor();
  await ui.locator('[name=review-proposal]').fill('调整标题前先复核预期');
  await ui.locator('[data-action=review-reconfirm]').click();
  await ui.locator('.ka-review-state').filter({hasText:'已重新确认'}).waitFor();
  await ui.locator('[data-action=review-withdraw]').click();
  await ui.locator('.ka-review-state').filter({hasText:'已撤回采纳'}).waitFor();
  const audit=await worker.evaluate(async()=>((await chrome.storage.local.get('kp-annotate-review-decisions-v1'))['kp-annotate-review-decisions-v1']));
  const records=Object.values(audit.records)[0];
  assert.equal(records.length,3);
  assert.deepEqual(records.map(e=>e.action),['reject','reconfirm','withdraw']);
  assert.equal(records[1].previousId,records[0].id);
  assert.equal(records[2].previousId,records[1].id);
  assert.equal(records[2].sourceSnapshotHash,records[0].sourceSnapshotHash);
  const saved=await worker.evaluate(async()=>JSON.parse(await snapshot()));
  assert.equal(saved.annotations[0].text,'请将标题改为新文案');
  assert.equal(saved.approvedSnapshot,undefined);
  assert.equal(saved.annotations[0].approvedReview,undefined);
  await ui.locator('[data-action=cancel]').click();
 });
 await check('非可信 DOM 点击和表单提交不能保存或修改原批注',async()=>{
  await ui.locator('[data-edit="1"]').click();
  await ui.locator('[name=text]').fill('合成页面脚本企图改写原话');
  await ui.locator('[data-action=save]').evaluate(button=>button.click());
  assert.equal(await ui.locator('.ka-editor').isVisible(),true,'脚本点击不能关闭编辑器');
  await ui.locator('.ka-editor form').evaluate(form=>form.requestSubmit());
  assert.equal(await ui.locator('.ka-editor').isVisible(),true,'隐式表单提交不能保存');
  const persisted=await worker.evaluate(async()=>JSON.parse(await snapshot()));
  assert.equal(persisted.annotations.find(a=>a.id===1)?.text,'请将标题改为新文案');
  await ui.locator('[data-action=cancel]').click();
 });
 await check('本地类别候选不覆盖原话，只有真实用户点击才采纳',async()=>{
  assert.equal(await ui.locator('[data-edit="1"]').count(),1,'真实保存后才进行编辑器候选验收');
  await ui.locator('[data-edit="1"]').click();
  await ui.locator('[name=text]').fill('这里有错别字');
  await ui.locator('.ka-category-suggestion').waitFor({state:'visible'});
  assert.equal(await ui.locator('[name=category]').inputValue(),'视觉');
  await ui.locator('[data-action=adopt-category]').evaluate(button=>button.click());
  assert.equal(await ui.locator('[name=category]').inputValue(),'视觉');
  await ui.locator('[data-action=dismiss-category]').click();
  assert.equal(await ui.locator('.ka-category-suggestion').isVisible(),false);
  await ui.locator('[name=text]').fill('文字错误需要调整');
  await ui.locator('.ka-category-suggestion').waitFor({state:'visible'});
  await ui.locator('[data-action=adopt-category]').click();
  assert.equal(await ui.locator('[name=category]').inputValue(),'文案');
  assert.equal(await ui.locator('[name=text]').inputValue(),'文字错误需要调整');
  await ui.locator('[data-action=cancel]').click();
 });
 await check('AI回写显示待验收、说明及提交，不自动替用户完成',async()=>{await worker.evaluate(()=>{projectResults=[{id:1,revision:'item-请将标题改为新文案',status:'待验收',summary:'标题已改，等待验收',branch:'codex/annotation-fixture',commit:'a'.repeat(40),checks:[{command:'node check.cjs',exitCode:0}]}];});await ui.locator('[data-action=project-read]').click();await ui.locator('.ka-ai-result').filter({hasText:'待验收'}).waitFor();assert((await ui.locator('.ka-ai-result').textContent()).includes('标题已改'));assert((await ui.locator('article a').first().textContent()).includes('未处理'));await page.screenshot({path:path.join(output,'ai-result-visible.png')});});
 await check('修改原话后旧AI结果立即失效；查询故障保留浏览器批注',async()=>{await ui.locator('[data-edit="1"]').click();await ui.locator('[name=text]').fill('请改成另一标题');await ui.locator('[data-action=save]').click();await ui.locator('.ka-editor').waitFor({state:'hidden'});assert.equal(await ui.locator('.ka-ai-result').count(),0);await worker.evaluate(()=>{projectFail=true;});await ui.locator('[data-action=project-read]').click();await ui.locator('.ka-project-summary').filter({hasText:'保留'}).waitFor();assert.equal(await worker.evaluate(async()=>JSON.parse(await snapshot()).annotations.length),1);await worker.evaluate(()=>{projectFail=false;});});
 await page.screenshot({path:path.join(output,'project-results.png')});report.status='passed';record();console.log(JSON.stringify({output,checks:report.checks.length,status:report.status}));
})().catch(e=>{report.status='failed';record();console.error(e);process.exitCode=1;}).finally(async()=>{if(context)await context.close();server.close();});
