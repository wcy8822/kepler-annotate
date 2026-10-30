'use strict';
if (typeof importScripts === 'function') importScripts('kp-annotate-store.js');
const KEY = ['kp', 'annotate', 'batch', 'v1'].join('-');
const LIBRARY = 'kp-annotate-library-v1';
const PROJECT_SYNC = 'kp-annotate-project-sync-v1';
let queue = Promise.resolve(), lastCapture = 0;
const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
const imagePath = key => typeof key === 'string' && /^(shots|refs)\/[\w.-]+\.(png|jpg|webp)$/.test(key);
const physicalPath = (batchId,key) => { if (!imagePath(key) || typeof batchId!=='string' || !batchId.trim()) throw Error('批次或图片路径无效'); return 'batches/'+encodeURIComponent(batchId)+'/'+key; };
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('kp-annotate-extension-assets-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('assets');
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error('图片存储被占用，请关闭旧插件页面后重试'));
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
  });
}
async function assets(mode, entries) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assets', mode), store = tx.objectStore('assets'), result = {};
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || Error('图片事务失败')); };
    for (const [key, value] of entries) {
      if (!imagePath(key) && !/^batches\/[\w%.:-]+\/(shots|refs)\/[\w.-]+\.(png|jpg|webp)$/.test(key)) { tx.abort(); return; }
      const r = mode === 'readonly' ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
      r.onsuccess = () => { result[key] = r.result; };
    }
  });
}
async function snapshot() { return (await chrome.storage.local.get(KEY))[KEY] ?? null; }
function conflict() { const e = Error('其他标签页已更新批注，草稿已保留，请加载最新后另存'); e.code = 'KP_ANNOTATION_CONFLICT'; return e; }
const cleanName = value => { if (typeof value!=='string' || !value.trim() || value.trim().length>80) throw Error('名称请填写1–80个字'); return value.trim(); };
function emptyBatch(projectId,name) { return {schemaVersion:1,batchId:crypto.randomUUID(),projectId,name:cleanName(name),status:'active',createdAt:new Date().toISOString(),nextId:1,annotations:[]}; }
async function readLibrary() {
  const data=(await chrome.storage.local.get(LIBRARY))[LIBRARY];
  if (!data) return null;
  const lib=JSON.parse(JSON.stringify(data));
  if (lib.schemaVersion!==1 || !Array.isArray(lib.projects) || !Array.isArray(lib.batches) || !lib.batches.some(b=>b.batchId===lib.activeBatchId) || !Number.isSafeInteger(lib.revision)) throw Error('批次目录异常，请先备份插件本地数据');
  return lib;
}
async function persistLibrary(lib) {
  lib.revision++;
  const active=lib.batches.find(b=>b.batchId===lib.activeBatchId);
  active.libraryRevision=lib.revision;
  active.projectName=lib.projects.find(p=>p.id===active.projectId).name;
  const raw=JSON.stringify(active);
  await chrome.storage.local.set({[LIBRARY]:lib,[KEY]:raw});
  return raw;
}
async function ensureLibrary() {
  let lib=await readLibrary();
  if (lib) return lib;
  const raw=await snapshot(),original=raw?JSON.parse(raw):null;
  if (original && (original.schemaVersion!==1 || !original.batchId || !Array.isArray(original.annotations) || !Number.isSafeInteger(original.nextId))) throw Error('原批次格式异常，已保留原始数据');
  const first=original?{...original,projectId:'default',name:'历史批注',status:'active',createdAt:new Date().toISOString()}:emptyBatch('default','第1批');
  const paths=[...new Set(first.annotations.flatMap(a=>[a.shot,...(a.refs||[])]))];
  const old=await assets('readonly',paths.map(p=>[p]));
  if (paths.some(p=>!old[p])) throw Error('历史批注缺少图片，已保留原始数据，请先导出或恢复图片');
  await assets('readwrite',paths.map(p=>[physicalPath(first.batchId,p),old[p]]));
  const copied=await assets('readonly',paths.map(p=>[physicalPath(first.batchId,p)]));
  if (paths.some(p=>copied[physicalPath(first.batchId,p)]!==old[p])) throw Error('迁移图片校验失败，已保留原始数据');
  lib={schemaVersion:1,revision:0,projects:[{id:'default',name:'默认项目'}],batches:[first],activeBatchId:first.batchId};
  await persistLibrary(lib);return lib;
}
async function libraryLoad() { await ensureLibrary();return snapshot(); }
async function catalog() {
  const lib=await ensureLibrary();return {projects:lib.projects,activeBatchId:lib.activeBatchId,batches:lib.batches.map(({batchId,projectId,name,status,createdAt,updatedAt,annotations})=>({batchId,projectId,name,status,createdAt,updatedAt,count:annotations.length}))};
}
async function manage(data) {
  const lib=await ensureLibrary();if(await snapshot()!==data.expected)throw conflict();
  const active=lib.batches.find(b=>b.batchId===lib.activeBatchId);
  const target=lib.batches.find(b=>b.batchId===data.batchId);
  if(data.action==='select'){if(!target)throw Error('批次不存在');lib.activeBatchId=target.batchId;}
  else if(data.action==='new-project'){
    const project={id:crypto.randomUUID(),name:cleanName(data.name)};lib.projects.push(project);const next=emptyBatch(project.id,data.batchName||'第1批');lib.batches.push(next);lib.activeBatchId=next.batchId;
  } else if(data.action==='new-batch'||data.action==='archive-new'){
    if(data.action==='archive-new'){active.status='archived';active.archivedAt=new Date().toISOString();}
    const projectId=data.projectId||active.projectId;if(!lib.projects.some(p=>p.id===projectId))throw Error('项目不存在');
    const next=emptyBatch(projectId,data.name||'新一批 '+new Date().toLocaleDateString('zh-CN'));lib.batches.push(next);lib.activeBatchId=next.batchId;
  } else if(data.action==='rename-batch'){active.name=cleanName(data.name);}
  else if(data.action==='rename-project'){lib.projects.find(p=>p.id===active.projectId).name=cleanName(data.name);}
  else if(data.action==='resume'){active.status='active';delete active.archivedAt;}
  else throw Error('未知批次操作');
  const raw=await persistLibrary(lib);
  await autoSyncProjects(lib,[active.projectId,lib.batches.find(b=>b.batchId===lib.activeBatchId).projectId],raw);
  return raw;
}
async function getBatchAsset(batchId,key) {
  const lib=await ensureLibrary();if(!lib.batches.some(b=>b.batchId===batchId))throw Error('图片所属批次不存在');
  const p=physicalPath(batchId,key);return (await assets('readonly',[[p]]))[p]??null;
}
async function pruneBatchAssets(data) {
  const lib=await ensureLibrary();if(await snapshot()!==data.expected||lib.activeBatchId!==data.batchId)return false;
  const used=new Set(lib.batches.find(b=>b.batchId===data.batchId).annotations.flatMap(a=>[a.shot,...(a.refs||[])]));
  await assets('readwrite',data.keys.filter(p=>!used.has(p)).map(p=>[physicalPath(data.batchId,p),null]));return true;
}
async function commit(data) {
  const lib=await ensureLibrary();
  if (await snapshot() !== data.expected) throw conflict();
  const batch = data.batch;
  if (!batch || batch.schemaVersion !== 1 || !batch.batchId || !Array.isArray(batch.annotations) || !Number.isSafeInteger(batch.nextId)) throw Error('批次格式无效');
  if(batch.batchId!==lib.activeBatchId)throw conflict();
  const previous=lib.batches.find(b=>b.batchId===batch.batchId);
  if(previous.status==='archived'&&batch.annotations.some(a=>!previous.annotations.some(old=>old.id===a.id)))throw Error('请先继续此批，再新增批注');
  const ids = batch.annotations.map(a => a.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id >= batch.nextId)) throw Error('批注编号无效');
  const incoming = Object.entries(data.assets || {});
  for (const [key, value] of incoming) if (!imagePath(key) || typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) throw Error('图片格式无效');
  const paths = [...new Set(batch.annotations.flatMap(a => [a.shot, ...(a.refs || [])]))];
  if (paths.some(p => !imagePath(p))) throw Error('批注图片路径无效');
  const physical=p=>physicalPath(batch.batchId,p),existing=await assets('readonly',paths.map(p=>[physical(p)]));
  if(paths.some(p=>!(data.assets||{})[p]&&!existing[physical(p)]))throw Error('批注图片不完整，已保留原批次');
  const backup=await assets('readonly',incoming.map(([p])=>[physical(p)]));
  if(incoming.some(([p,value])=>backup[physical(p)]&&backup[physical(p)]!==value))throw Error('已保存的图片不可覆盖，请使用新图片路径');
  await assets('readwrite',incoming.map(([p,value])=>[physical(p),value]));
  lib.batches[lib.batches.indexOf(previous)]={...batch,projectId:previous.projectId,name:previous.name,status:previous.status,archivedAt:previous.archivedAt,createdAt:previous.createdAt,updatedAt:new Date().toISOString()};
  let raw;
  try{raw=await persistLibrary(lib);}
  catch(error){await assets('readwrite',incoming.map(([p])=>[physical(p),backup[physical(p)]??null]));throw error;}
  await autoSyncProjects(lib,[previous.projectId],raw);
  return raw;
}
async function capture(sender) {
  const windowId = sender.tab.windowId, tabId = sender.tab.id;
  let changed = false, expectedURL;
  const activated = info => { if (info.windowId === windowId) changed = true; };
  const updated = (id, info) => { if (id === tabId && (info.url || info.status === 'loading')) changed = true; };
  const removed = id => { if (id === tabId) changed = true; };
  chrome.tabs.onActivated.addListener(activated);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved.addListener(removed);
  const check = async () => {
    const tab = await chrome.tabs.get(tabId);
    const active = (await chrome.tabs.query({active: true, windowId}))[0];
    if (changed || !active || active.id !== tabId || tab.url !== expectedURL) throw Error('截图期间标签页或页面已变化，草稿已保留，请保持当前页面后重试');
  };
  try {
    if (!sender.documentId) throw Error('批注文档已失效，请刷新后重新打开工具');
    const [current] = await chrome.scripting.executeScript({target: {tabId, documentIds: [sender.documentId]}, world: 'ISOLATED', func: () => location.href});
    const currentURL = current?.result;
    if (!currentURL || new URL(currentURL).origin !== new URL(sender.url).origin) throw Error('批注页面已变化，请回到原页面后重试');
    expectedURL = currentURL;
    await check();
    const delay = Math.max(0, 600 - (Date.now() - lastCapture));
    if (delay) await new Promise(r => setTimeout(r, delay));
    await check();
    lastCapture = Date.now();
    const image = await chrome.tabs.captureVisibleTab(windowId, {format: 'png'});
    await check();
    return image;
  } finally {
    chrome.tabs.onActivated.removeListener(activated);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.tabs.onRemoved.removeListener(removed);
  }
}
const CODEX_TARGETS = 'kp-annotate-codex-targets-v1';
function codexThread(value) {
  const id = String(value || '').trim().replace(/^codex:\/\/threads\//, '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('请粘贴 Codex 本地对话链接或对话 ID');
  return id.toLowerCase();
}
async function nativeCodex(message) {
  let result;
  try { result = await chrome.runtime.sendNativeMessage('com.kepler.annotate', message); }
  catch (error) {
    if (/native messaging host not found|access to the specified native messaging host is forbidden/i.test(error.message)) throw Error('本地接入未就绪，请先运行插件目录中的 install-native-host.py；批注已保留。' + error.message);
    if (message.op === 'send') throw Error('发送结果待核对，请先查看目标对话 codex://threads/' + message.threadId + ' 和本机交接回执；原批次已保留，请勿直接重复发送。' + error.message);
    throw Error('本地接入暂时未响应，批注已保留。' + error.message);
  }
  if (!result?.ok) throw Error(result?.error || 'Codex 接入未返回结果；请检查目标对话，原批次已保留');
  return result;
}
async function codexInfo(data) {
  if (await snapshot() !== data.expected) throw conflict();
  const batch = JSON.parse(data.expected), saved = (await chrome.storage.local.get(CODEX_TARGETS))[CODEX_TARGETS] || {};
  const info = await nativeCodex({op: 'info'});
  return {threadId: saved[batch.projectId] || info.defaultThread || ''};
}
async function sendToCodex(data) {
  const threadId = codexThread(data.threadId);
  if (await snapshot() !== data.expected) throw conflict();
  const batch = JSON.parse(data.expected);
  if (!batch.annotations.length) throw Error('请先保存至少一条批注');
  const paths = [...new Set(batch.annotations.flatMap(a => [a.shot, ...(a.refs || [])]).filter(Boolean))], images = {};
  for (const name of paths) {
    if (!imagePath(name)) throw Error('图片路径无效');
    images[name] = await getBatchAsset(batch.batchId, name);
    if (!images[name]) throw Error('缺少批注图片：' + name + '，本批数据已保留');
  }
  if (await snapshot() !== data.expected) throw conflict();
  const result = await nativeCodex({op: 'send', threadId, batch, aiTasks: data.aiTasks, markdown: data.markdown, assets: images});
  if (result.state !== 'queued') throw Error('交接状态待核对，请查看目标对话；原批次已保留');
  try {
    const saved = (await chrome.storage.local.get(CODEX_TARGETS))[CODEX_TARGETS] || {};
    await chrome.storage.local.set({[CODEX_TARGETS]: {...saved, [batch.projectId]: threadId}});
  } catch (_) { result.warning = '消息已排队；本机未能记住目标对话，下次请重新选择。'; }
  return result;
}
async function checkProjectSnapshot(expected) {
  if(await snapshot()!==expected)throw conflict();
}
async function projectSyncState(projectId,state,message,result={}) {
  const value={projectId,state,message,updatedAt:new Date().toISOString()};
  for(const key of ['projectRoot','batchId','revision'])if(result[key]!==undefined)value[key]=result[key];
  try {
    const saved=(await chrome.storage.local.get(PROJECT_SYNC))[PROJECT_SYNC]||{};
    await chrome.storage.local.set({[PROJECT_SYNC]:{...saved,[projectId]:value}});
  } catch (_) {}
  return value;
}
async function projectPayload(batch) {
  const paths=[...new Set(batch.annotations.flatMap(a=>[a.shot,...(a.refs||[])]))];
  if(paths.some(p=>!imagePath(p)))throw Error('批注图片路径无效，浏览器批注已保留');
  const entries=await assets('readonly',paths.map(p=>[physicalPath(batch.batchId,p)])),images={};
  for(const name of paths){const value=entries[physicalPath(batch.batchId,name)];if(!value)throw Error('缺少批注图片：'+name+'，浏览器批注已保留');images[name]=value;}
  return {batch,aiTasks:globalThis.KPAnnotationStore.aiTasks(batch),markdown:globalThis.KPAnnotationStore.markdown(batch),assets:images};
}
async function syncProject(lib,projectId,expected,batchId) {
  await checkProjectSnapshot(expected);
  const info=await nativeCodex({op:'project-info',projectId});
  await checkProjectSnapshot(expected);
  if(!info.binding){await projectSyncState(projectId,'unbound','项目尚未绑定本地目录');return {ok:true,bound:false};}
  if(info.binding.projectId!==projectId)throw Error('项目绑定身份不一致，浏览器批注已保留');
  const project=lib.projects.find(p=>p.id===projectId),batches=lib.batches.filter(b=>b.projectId===projectId&&(!batchId||b.batchId===batchId));
  const payloads=[];
  for(const batch of batches)payloads.push(await projectPayload({...batch,projectName:project.name}));
  await checkProjectSnapshot(expected);
  let current;
  for(const payload of payloads){
    await checkProjectSnapshot(expected);
    const result=await nativeCodex({op:'project-sync',...payload});
    await checkProjectSnapshot(expected);
    if(result.bound===false){await projectSyncState(projectId,'unbound','项目尚未绑定本地目录');return result;}
    if(result.bound!==true||result.batchId!==payload.batch.batchId||typeof result.revision!=='string'||!Array.isArray(result.items))throw Error('项目同步回执无效，浏览器批注已保留');
    if(!current||payload.batch.batchId===lib.activeBatchId)current=result;
  }
  await projectSyncState(projectId,'synced','浏览器批注已同步到本地项目',current);
  return {...current,binding:info.binding};
}
async function autoSyncProjects(lib,projectIds,expected) {
  for(const projectId of new Set(projectIds)){
    try{await syncProject(lib,projectId,expected);}
    catch(error){await projectSyncState(projectId,'error','浏览器保存成功，本地项目同步待重试：'+error.message);}
  }
}
async function projectRPC(op,data) {
  const lib=await ensureLibrary();await checkProjectSnapshot(data.expected);
  const batch=lib.batches.find(b=>b.batchId===lib.activeBatchId),project=lib.projects.find(p=>p.id===batch.projectId),projectId=project.id;
  try {
    if(op==='project-info'){
      const info=await nativeCodex({op,projectId});await checkProjectSnapshot(data.expected);
      const saved=(await chrome.storage.local.get(PROJECT_SYNC))[PROJECT_SYNC]||{};
      await checkProjectSnapshot(data.expected);return {...info,sync:saved[projectId]||null};
    }
    if(op==='project-bind'){
      if(typeof data.projectRoot!=='string'||!data.projectRoot.trim())throw Error('请填写本地项目目录');
      await nativeCodex({op,projectId,projectName:project.name,projectRoot:data.projectRoot.trim()});
      await checkProjectSnapshot(data.expected);
      return await syncProject(lib,projectId,data.expected);
    }
    const synced=await syncProject(lib,projectId,data.expected,batch.batchId);
    if(op==='project-sync'||synced.bound===false)return synced;
    await checkProjectSnapshot(data.expected);
    const result=await nativeCodex({op:'project-read',projectId,batchId:batch.batchId});
    await checkProjectSnapshot(data.expected);
    if(result.bound!==true||result.batchId!==batch.batchId||result.projectRoot!==synced.projectRoot||result.revision!==synced.revision||!Array.isArray(result.items)||result.items.length!==synced.items.length||result.items.some(item=>!synced.items.some(saved=>saved.id===item.id&&saved.revision===item.revision)))throw Error('项目结果版本已变化，请重新读取当前批次');
    return result;
  } catch(error){await projectSyncState(projectId,'error','浏览器批注已保留：'+error.message);throw error;}
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !/^(https?|file):/.test(sender.url || '')) throw Error('批注消息来源无效');
  switch (message.op) {
    case 'load': return serial(libraryLoad);
    case 'catalog': return serial(catalog);
    case 'manage': return serial(()=>manage(message));
    case 'commit': return serial(() => commit(message));
    case 'getAsset': return serial(()=>getBatchAsset(message.batchId,message.key));
    case 'prune': return serial(()=>pruneBatchAssets(message));
    case 'codex-info': return serial(()=>codexInfo(message));
    case 'codex-send': return serial(()=>sendToCodex(message));
    case 'project-info': case 'project-bind': case 'project-sync': case 'project-read': return serial(()=>projectRPC(message.op,message));
    case 'capture': return serial(() => capture(sender));
    case 'build': {
      const url = new URL(sender.url);
      if (!/\/kepler-v4\//.test(url.pathname)) return null;
      const buildURL = new URL('BUILD.json', url);
      const response = await fetch(buildURL.href, {credentials: 'include', signal: AbortSignal.timeout(4000)});
      if (!response.ok) return {status: 'BUILD.json 读取失败', url: buildURL.href};
      return response.json();
    }
    default: throw Error('未知批注操作');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.channel !== 'kepler-annotate-v1') return;
  handle(message, sender).then(value => reply({ok: true, value}), error => reply({ok: false, error: error.message, code: error.code}));
  return true;
});
async function inject(tab) {
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) throw Error('Chrome 内置页面、扩展商店和内置 PDF 阅读器不支持网页批注，请打开普通网页');
  const css = await (await fetch(chrome.runtime.getURL('kp-annotate.css'))).text();
  const [document] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'ISOLATED', func: text => { globalThis.KPAnnotationCSS = text; }, args: [css]});
  if (!document?.documentId) throw Error('页面已变化，请重新点击插件图标');
  await chrome.scripting.executeScript({target: {tabId: tab.id, documentIds: [document.documentId]}, world: 'ISOLATED', files: ['vendor/jszip.min.js', 'kp-annotate-store.js', 'kp-annotate-project.js', 'kp-annotate.js']});
  await chrome.action.setBadgeText({tabId: tab.id, text: ''});
  await chrome.action.setTitle({tabId: tab.id, title: '打开／收起网页批注'});
}
chrome.action.onClicked.addListener(tab => {
  inject(tab).catch(async error => {
    await chrome.action.setBadgeText({tabId: tab.id, text: '!'});
    await chrome.action.setBadgeBackgroundColor({tabId: tab.id, color: '#b42318'});
    await chrome.action.setTitle({tabId: tab.id, title: '批注未打开：' + error.message});
  });
});
