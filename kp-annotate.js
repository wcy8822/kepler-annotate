(() => {
  'use strict';
  if (window.KPAnnotate) { window.KPAnnotate.toggle(); return; }
  if (window.KPAnnotateStarting) return;
  window.KPAnnotateStarting = true;
  async function start() {
    await window.KPAnnotationStore.initialize();
    const store = window.KPAnnotationStore;
    let storedSnapshot = store.rawSnapshot();
    let batch = store.load(), mode = 'browse', enabled = true, draft = null, reference = null, drawing = null, busy = false, routeVersion = 0, viewportVersion = 0;
    store.assertUnchanged(storedSnapshot);
    let build = null;
    await store.rpc('build').then(value => { build = value; }).catch(() => { build = {status: 'BUILD.json 读取失败'}; });
    const host = document.createElement('div'); host.id = 'kp-annotate-host';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important';
    const shadow = host.attachShadow({mode: 'open'});
    const sheet = new CSSStyleSheet(); sheet.replaceSync(globalThis.KPAnnotationCSS); shadow.adoptedStyleSheets = [sheet];
    const freezeStage = document.createElement('dialog'); freezeStage.className = 'ka-freeze-stage'; freezeStage.setAttribute('aria-label','定格画面批注'); shadow.append(freezeStage);
    const root = document.createElement('div'); root.id = 'kp-annotate-root';
    root.innerHTML = `<canvas class="ka-frozen" hidden aria-label="已定格的网页画面"></canvas><svg class="ka-layer" aria-label="批注绘图层"></svg><div class="ka-markers"></div>
      <div class="ka-toolbar" data-html2canvas-ignore="true" role="toolbar" aria-label="批注工具">
        <span class="ka-caption">本地批注</span><button data-mode="browse">浏览</button><button data-mode="point">点选</button><button data-mode="region">框选</button><button data-mode="pen">画笔</button><button data-mode="arrow">箭头</button><button data-mode="reference">参照</button>
        <button data-action="freeze-delay" title="3秒内展开目标后自动定格；Alt+Shift+S可立即定格">3秒后圈选</button><button data-action="unfreeze" hidden>恢复交互</button><button data-action="list" aria-expanded="false">清单 <span class="ka-count">0</span></button><button data-action="project">项目本地</button><button data-action="codex">发送到 Codex</button><button data-action="export">导出</button><button data-action="close" aria-label="关闭批注（Alt+A）">关闭</button>
      </div><aside class="ka-list" data-html2canvas-ignore="true" aria-label="批注清单" hidden></aside>
      <dialog class="ka-editor" data-html2canvas-ignore="true" aria-label="编辑批注"><form method="dialog">
        <h2>写批注</h2><p class="ka-target"></p><label>类别<select name="category"><option>视觉</option><option>文案</option><option>交互</option><option>产品逻辑</option><option>反馈/建议</option></select></label><label>处理状态<select name="status"><option>未处理</option><option>处理中</option><option>待验收</option><option>已完成</option></select></label>
        <label>一句话说明<textarea name="text" rows="4" required maxlength="4000" placeholder="希望改成什么样？"></textarea></label>
        <section class="ka-category-suggestion" hidden aria-label="本地类别建议"><strong></strong><p class="ka-category-reason"></p><div><button type="button" data-action="adopt-category">采用此类别</button><button type="button" data-action="dismiss-category">仅保留当前分类</button></div></section>
        <details><summary>补充观察、预期与复现（选填）</summary><label>实际看到什么<textarea name="observed" rows="2" maxlength="4000"></textarea></label><label>希望怎样<textarea name="expected" rows="2" maxlength="4000"></textarea></label><label>如何复现<textarea name="reproduction" rows="2" maxlength="4000"></textarea></label></details><label>参考图 · Ctrl+V / ⌘V 粘贴，或选择图片<input type="file" name="reference" accept="image/*" multiple></label><div class="ka-refs"></div>
        <p class="ka-editor-status" role="status"></p><footer><button type="button" data-action="cancel">取消</button><button type="button" data-action="save">保存批注</button></footer>
      </form></dialog><dialog class="ka-manager" aria-label="批次管理"><form><h2></h2><p class="ka-management-hint"></p><label>名称<input name="management-name" maxlength="80" required></label><p role="status"></p><footer><button type="button" data-action="manage-cancel">取消</button><button type="submit">确定</button></footer></form></dialog><div class="ka-status" role="status" data-html2canvas-ignore="true"></div>`;
    shadow.append(root); document.documentElement.append(host);
    new ResizeObserver(()=>root.style.setProperty('--ka-toolbar-height',Math.ceil(root.querySelector('.ka-toolbar').getBoundingClientRect().height)+'px')).observe(root.querySelector('.ka-toolbar'));
    const codexHost = document.createElement('div'), codexShadow = codexHost.attachShadow({mode:'closed'});
    codexShadow.adoptedStyleSheets = [sheet]; root.append(codexHost);
    codexShadow.innerHTML = `<div id="kp-annotate-root"><dialog class="ka-codex" aria-label="发送批注到 Codex"><form><h2>发送本批到 Codex</h2><p class="ka-codex-summary"></p><label>目标对话<input name="codex-thread" required placeholder="codex://threads/对话ID" autocomplete="off"></label><p>在目标 Codex 对话按 ⌘⌥L 复制链接（Windows：Ctrl+Alt+L）。每个项目会记住上次发送的对话。</p><p>原话、分类、网址、版本及截图自动保存到本机，再交给这个对话，无需下载或上传 ZIP。发送后作为消息排队，Codex 会继续处理。</p><p class="ka-codex-status" role="status"></p><a class="ka-codex-link" hidden>查看目标对话</a><footer><button type="button" data-action="codex-cancel">关闭</button><button type="submit">发送本批</button></footer></form></dialog></div>`;
    const codexDialog = codexShadow.querySelector('.ka-codex'), codexInput = codexDialog.querySelector('input');
    const $ = s => s.startsWith('.ka-codex') ? (s === '.ka-codex' ? codexDialog : codexShadow.querySelector(s)) : root.querySelector(s), layer = $('.ka-layer'), markers = $('.ka-markers'), editor = $('.ka-editor'), list = $('.ka-list');
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let noticeTimer, freezeTimer, frozen = null, categoryFilter = '', statusFilter = '', selected = new Set(), managementAction = null, managementSnapshot = null;
    let categorySuggestion = null, dismissedSuggestionKey = null;
    let projectUI;
    let codexSnapshot = null, codexTarget = '', codexTargetEdited = false, codexSubmitter = null, codexRequest = null;
    const categories = ['视觉','文案','交互','产品逻辑','反馈/建议'], statuses = ['未处理','处理中','待验收','已完成'];
    const options = (values,value,all='') => (all ? `<option value="">${all}</option>` : '') + values.map(x=>`<option ${x===value?'selected':''}>${escape(x)}</option>`).join('');
    function releaseFreeze() {
      frozen = null; $('.ka-caption').textContent = '本地批注'; delete root.dataset.frozen; $('.ka-frozen').hidden = true; $('[data-action=unfreeze]').hidden = true;
      if (freezeStage.open && !editor.open) { freezeStage.close(); shadow.append(root); }
    }
    function viewportState() { return {width:innerWidth,height:innerHeight,scrollX,scrollY,ratio:devicePixelRatio,scale:visualViewport?.scale}; }
    function notice(text) { $('.ka-status').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('.ka-status').textContent = ''; }, 6500); }
    function refreshBatch() {
      const snapshot = store.rawSnapshot(), latest = store.load();
      store.assertUnchanged(snapshot);
      if(batch.batchId!==latest.batchId){selected.clear();releaseFreeze();}
      storedSnapshot = snapshot; batch = latest;
    }
    async function commit(next) {
      await store.save(next, storedSnapshot); storedSnapshot = store.rawSnapshot(); batch = store.load();
    }
    function setBusy(value) {
      busy = value;
      editor.querySelectorAll('button,input,textarea,select').forEach(el => { el.disabled = value; });
      $('.ka-codex').querySelectorAll('button,input').forEach(el => { el.disabled = value; });
    }
    async function locked(operation) {
      if (busy) throw Error('请等待当前操作完成');
      setBusy(true);
      try { return await store.withBatchLock(async () => { store.assertUnchanged(storedSnapshot); return operation(); }); }
      finally {
        setBusy(false);
        if (!editor.open && store.rawSnapshot() !== storedSnapshot) { refreshBatch(); renderMarks(); renderList(); }
      }
    }
    function draftError(error, retry = false) {
      const status = $('.ka-editor-status'); status.textContent = error.message;
      if (retry || error.code === 'KP_ANNOTATION_CONFLICT') {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = draft?.batchId !== store.load().batchId ? 'return-batch' : 'retry';
        button.textContent = draft?.batchId !== store.load().batchId ? '返回草稿批次' : '加载最新并另存为新批注'; button.disabled = busy; status.append(' ', button);
      }
      if (draft && draft.pageKey !== key()) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = 'return-draft';
        button.textContent = '返回批注页面'; button.disabled = busy; status.append(' ', button);
      }
    }
    async function retryDraft() {
      if (!draft || busy) return;
      setBusy(true);
      try {
        await store.withBatchLock(async () => {
          const snapshot = store.rawSnapshot(), latest = store.load();
          store.assertUnchanged(snapshot);
          if (draft.batchId !== latest.batchId) throw Error('请先返回草稿批次，内容已保留');
          const copies = [];
          for (const name of draft.refs) {
            const blob = await store.getAsset(name);
            if (!blob) throw Error('参考图已被其他标签页删除：' + name + '。请先移除该图或重新添加，再点击另存。');
            copies.push(blob);
          }
          store.assertUnchanged(snapshot);
          if(batch.batchId!==latest.batchId){selected.clear();releaseFreeze();}
      storedSnapshot = snapshot; batch = latest;
          draft = { ...draft, needsRebase:false, id: batch.nextId, existing: false, shot: `shots/${String(batch.nextId).padStart(3,'0')}.png`, refs: [], pendingRefs: [...draft.pendingRefs, ...copies], removedRefs: [] };
          $('.ka-target').textContent = `另存为新批注 #${draft.id} · ${draft.elements.map(e => e.text).join(' / ') || '手绘区域'}`;
          renderRefs(); renderMarks();
          draftError(Error(`草稿已保留，将另存为 #${draft.id}。请确认内容后点击「保存批注」。`));
        });
      } catch (error) { draftError(error, true); }
      finally { setBusy(false); }
    }
    function key() { return store.pageKey(location.href); }
    function currentItems() { return batch.batchId === store.load().batchId ? batch.annotations.filter(a => (a.pageKey || store.pageKey(a.url)) === key()) : []; }
    function setMode(value) {
      if (busy) return;
      if(value!=='browse'&&batch.status==='archived'){notice('本批已归档，请在清单中点击「继续此批」后新增');return;}
      clearTimeout(freezeTimer); freezeTimer = null;
      if (!['region','pen','arrow'].includes(value)) releaseFreeze();
      mode = value; reference = null; drawing = null; root.dataset.mode = mode;
      root.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      renderMarks();
      if (value === 'reference') notice('先点要改的元素，再点参照元素');
    }
    function point(event) { return { x: event.clientX + scrollX, y: event.clientY + scrollY }; }
    function rectOf(a, b) { return { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), width: Math.abs(a.x-b.x), height: Math.abs(a.y-b.y) }; }
    function targetOf(event) { return event.target instanceof Element ? event.target : event.target.parentElement; }
    function isTool(el) { return !el || (el === host || !!el.closest('#kp-annotate-root')); }
    function liveRect(item, snapshot = frozen) {
      if (snapshot?.batchId === batch.batchId && snapshot.rects[item.id]) return snapshot.rects[item.id];
      if (item.mode === 'point' || item.mode === 'reference') {
        try { const el = document.querySelector(item.elements[0].selector); if (el) { const rect = store.describe(el).rect; if (rect.width && rect.height) return rect; } } catch (_) { /* 已变化的页面按原坐标显示。 */ }
      }
      return item.rect;
    }
    function shapeSVG(shape) {
      const points = shape.points || [], a = points[0], b = points[points.length-1];
      if (shape.type === 'region') return `<rect x="${shape.rect.x-scrollX}" y="${shape.rect.y-scrollY}" width="${shape.rect.width}" height="${shape.rect.height}"/>`;
      if (!a || !b) return '';
      const path = `<polyline points="${points.map(p => `${p.x-scrollX},${p.y-scrollY}`).join(' ')}"/>`;
      if (shape.type !== 'arrow') return path;
      const angle = Math.atan2(b.y-a.y,b.x-a.x), length = 15;
      return path + `<polyline points="${b.x-scrollX-length*Math.cos(angle-.5)},${b.y-scrollY-length*Math.sin(angle-.5)} ${b.x-scrollX},${b.y-scrollY} ${b.x-scrollX-length*Math.cos(angle+.5)},${b.y-scrollY-length*Math.sin(angle+.5)}"/>`;
    }
    function renderMarks(highlight) {
      const items = currentItems();
      let shapes = items.flatMap(a => a.shapes || []);
      if (draft && draft.batchId === store.load().batchId && !draft.existing && draft.pageKey === key()) shapes = shapes.concat(draft.shapes || []);
      if (drawing) shapes.push(drawing.type === 'region' ? {type:'region',rect:rectOf(drawing.points[0],drawing.points.at(-1))} : drawing);
      layer.innerHTML = shapes.map(shapeSVG).join('') + (highlight ? `<rect class="ka-highlight" x="${highlight.x-scrollX}" y="${highlight.y-scrollY}" width="${highlight.width}" height="${highlight.height}"/>` : '');
      const shown = items.concat(draft && draft.batchId === store.load().batchId && !draft.existing && draft.pageKey === key() ? [draft] : []);
      markers.innerHTML = shown.map(item => { const r=liveRect(item); return `<button class="ka-marker" data-id="${item.id}" aria-label="编辑批注 ${item.id}" style="left:${Math.max(2,r.x-scrollX)}px;top:${Math.max(2,r.y-scrollY)}px">${item.id}</button>`; }).join('');
      $('.ka-count').textContent = batch.annotations.length;
    }
    function aiResultMarkup(id) {
      const r=projectUI?.resultFor(id);if(!r)return '';
      return `<div class="ka-ai-result"><strong>AI · ${escape(r.status)}</strong><p>${escape(r.summary)}</p>${r.branch?`<small>${escape(r.branch)} · ${escape(r.commit||'')}</small>`:''}${r.checks?.length?`<details><summary>验证记录</summary>${r.checks.map(c=>`<p>${escape(c.command)} · 退出码 ${escape(c.exitCode)}</p>`).join('')}</details>`:''}</div>`;
    }
    function renderList() {
      const catalog = store.getCatalog(), items = batch.annotations.filter(a=>(!categoryFilter || a.category===categoryFilter) && (!statusFilter || (a.status||'未处理')===statusFilter)), groups = new Map();
      for (const item of items) { const site = new URL(item.url).origin; if (!groups.has(site)) groups.set(site, new Map()); const pages=groups.get(site), page=item.pageKey||store.pageKey(item.url); if(!pages.has(page))pages.set(page,[]);pages.get(page).push(item); }
      const project = catalog.projects.find(p=>p.id===batch.projectId);
      list.innerHTML = `<header><h2>项目与批次 · ${batch.annotations.length}</h2><button data-action="list" aria-label="折叠清单">折叠</button></header><div class="ka-list-body"><div class="ka-management"><label>项目<select name="project">${catalog.projects.map(p=>`<option value="${escape(p.id)}" ${p.id===batch.projectId?'selected':''}>${escape(p.name)}</option>`).join('')}</select></label><label>批次<select name="batch">${catalog.batches.filter(b=>b.projectId===batch.projectId).map(b=>`<option value="${escape(b.batchId)}" ${b.batchId===batch.batchId?'selected':''}>${escape(b.name)} · ${b.status==='archived'?'已归档':'进行中'} · ${b.count}条</option>`).join('')}</select></label><small>${escape(project?.name)} / ${escape(batch.name)} · ${batch.status==='archived'?'已归档，可编辑明细；新增前请继续此批':'进行中'}</small><div class="ka-management-buttons"><button data-action="new-project">新项目</button><button data-action="new-batch">新批次</button><button data-action="rename-project">改项目名</button><button data-action="rename-batch">改批次名</button>${batch.status==='archived'?'<button data-action="resume">继续此批</button>':'<button data-action="archive-new">归档并新建</button>'}</div></div><p class="ka-project-summary" role="status">${escape(projectUI?.summary()||'尚未读取项目设置')}</p><button data-action="project-read">读取 AI 结果</button><div class="ka-filters"><label>分类筛选<select name="filter-category">${options(categories,categoryFilter,'全部分类')}</select></label><label>状态筛选<select name="filter-status">${options(statuses,statusFilter,'全部状态')}</select></label></div><small>显示 ${items.length} / 本批 ${batch.annotations.length} 条 · 已选 ${selected.size} 条</small><div class="ka-bulk"><label><input type="checkbox" name="select-visible" ${items.length&&items.every(a=>selected.has(a.id))?'checked':''}> 选中当前筛选</label><select name="bulk-category" aria-label="批量分类">${options(categories,'','选择分类')}</select><button data-action="bulk-category">批量归类</button><select name="bulk-status" aria-label="批量状态">${options(statuses,'','选择状态')}</select><button data-action="bulk-status">批量改状态</button></div>` + [...groups].map(([site,pages])=>`<section class="ka-site"><h3>${escape(site)}</h3>${[...pages.values()].map(rows=>`<section><h4>${escape(rows[0].title)}</h4><small>${escape(rows[0].pageKey||rows[0].url)}</small>${rows.map(a=>`<article><input type="checkbox" data-select="${a.id}" aria-label="选择批注 ${a.id}" ${selected.has(a.id)?'checked':''}><a href="${escape(a.url)}" data-return="${a.id}">#${a.id} · ${escape(a.category)} · ${escape(a.status||'未处理')} · ${escape(a.text.slice(0,60))}</a><div><button data-edit="${a.id}">编辑</button><button data-delete="${a.id}">删除</button></div>${aiResultMarkup(a.id)}</article>`).join('')}</section>`).join('')}</section>`).join('') + (groups.size?'':'<p>当前筛选暂无批注。可切换历史批次或开始新一批。</p>') + `</div><footer><button data-action="clear">清空工作区（保留存档）</button><button data-action="export">导出本批（全部${batch.annotations.length}条）</button><small>归档可随时找回；清单筛选不改变导出范围。</small></footer>`;
    }
    async function manage(data) {
      if(editor.open)throw Error('请先保存或取消当前草稿，再管理批次');
      await locked(async()=>{await store.manage(data,storedSnapshot);refreshBatch();selected.clear();});
      setMode('browse');renderList();
    }
    function openManagement(action) {
      if(busy||editor.open)return;
      managementAction=action;managementSnapshot=storedSnapshot;const dialog=$('.ka-manager');
      const names={'new-project':'新建项目','new-batch':'新建批次','rename-project':'修改项目名','rename-batch':'修改批次名','archive-new':'归档并新建','clear':'清空工作区并保留存档'};
      dialog.querySelector('h2').textContent=names[action];dialog.querySelector('.ka-management-hint').textContent=['clear','archive-new'].includes(action)?`本批 ${batch.annotations.length} 条和全部截图会保存为存档，随时可以从批次列表找回。请填写下一批名称。`:'项目和批次均保存在当前浏览器本机。';
      dialog.querySelector('input').value=action==='rename-project'?batch.projectName:action==='rename-batch'?batch.name:action==='new-project'?'':'新一批 '+new Date().toLocaleDateString('zh-CN');dialog.querySelector('[role=status]').textContent='';dialog.showModal();dialog.querySelector('input').focus();
    }
    function toggleList() { list.hidden = !list.hidden; $('[data-action="list"]').setAttribute('aria-expanded',String(!list.hidden)); if (!list.hidden) renderList(); }
    function draftFor(elements, rect, shapes=[]) {
      if(batch.status==='archived')throw Error('本批已归档，请在清单中点击「继续此批」后新增');
      return { batchId:batch.batchId, id:batch.nextId, mode, status:'未处理', category:'视觉', text:'', url:location.href, pageKey:key(), title:document.title || location.hostname, elements, rect, shapes, viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}, build, ...(frozen ? {snapshot:frozen} : {}), shot:`shots/${String(batch.nextId).padStart(3,'0')}.png`, refs:[], createdAt:new Date().toISOString() };
    }

    function categoryInputs() {
      return Object.fromEntries(['text','observed','expected','reproduction'].map(field => [field, $('[name=' + field + ']').value]));
    }
    function renderCategorySuggestion() {
      const panel = $('.ka-category-suggestion');
      categorySuggestion = null;
      panel.hidden = true;
      if (!draft || !editor.open) return;
      const input = categoryInputs(), key = JSON.stringify(input);
      const candidate = store.suggestCategory(input);
      if (!candidate || candidate.category === $('[name=category]').value || key === dismissedSuggestionKey) return;
      categorySuggestion = {...candidate, key};
      panel.querySelector('strong').textContent = candidate.category + ' · 本地规则候选';
      panel.querySelector('.ka-category-reason').textContent = candidate.reason + '；仅作分类参考，原话不会被修改。';
      panel.hidden = false;
    }
    function openDraft(item, existing=false) {
      if (busy) return;
      draft = {...item, batchId:batch.batchId, existing, pendingRefs:[], removedRefs:[]};
      $('.ka-target').textContent = existing ? `编辑 #${item.id} · ${item.elements.map(e=>e.text).join(' → ')}` : item.mode==='reference' ? '改成像这个：'+item.elements.map(e=>e.text).join(' → ') : `#${item.id} · ${item.elements.map(e=>e.text).join(' / ') || '手绘区域'}`;
      for(const field of ['observed','expected','reproduction'])$('[name='+field+']').value=item[field]||''; $('[name=status]').value=item.status||'未处理';
      $('[name=text]').value=item.text; $('[name=category]').value=item.category; $('.ka-editor-status').textContent=''; $('[name=reference]').value=''; renderRefs(); renderMarks(); editor.showModal(); dismissedSuggestionKey = null; renderCategorySuggestion(); $('[name=text]').focus();
    }
    function renderRefs() {
      $('.ka-refs').replaceChildren();
      for (const name of draft.refs) { const p=document.createElement('span'); p.textContent=name.split('/').at(-1); const b=document.createElement('button'); b.type='button'; b.textContent='移除'; b.onclick=()=>{draft.refs=draft.refs.filter(x=>x!==name);draft.removedRefs.push(name);renderRefs();};p.append(b);$('.ka-refs').append(p); }
      draft.pendingRefs.forEach((blob,i) => {const image=document.createElement('canvas'); image.setAttribute('aria-label', `待保存参考图 ${i+1}`); createImageBitmap(blob).then(bitmap=>{image.width=bitmap.width;image.height=bitmap.height;image.getContext('2d').drawImage(bitmap,0,0);bitmap.close();}).catch(()=>{image.setAttribute('aria-label','参考图预览失败，保存时会保留原图');});$('.ka-refs').append(image);});
    }
    function addRefs(files) { if (!draft || busy) return; for (const f of files) if(f.type.startsWith('image/')) draft.pendingRefs.push(f); renderRefs(); }
    async function referenceImage(blob) {
      if (['image/png','image/jpeg','image/webp'].includes(blob.type)) return blob;
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
      canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      return new Promise((resolve,reject)=>canvas.toBlob(image=>image?resolve(image):reject(Error('参考图转换失败，请改用 PNG / JPEG / WebP')),'image/png'));
    }
    async function libraries() { if (!window.JSZip) throw Error('插件 ZIP 资源未加载，请刷新后重试'); }
    function paint(ctx, shape) {
      ctx.strokeStyle=getComputedStyle(root).getPropertyValue('--ka-ink').trim();ctx.lineWidth=3;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();
      if (shape.type==='region') {const r=shape.rect;ctx.strokeRect(r.x-scrollX,r.y-scrollY,r.width,r.height);return;}
      const points=shape.points || [];points.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](p.x-scrollX,p.y-scrollY));ctx.stroke();
      if(shape.type==='arrow' && points.length>1){const a=points[0],b=points.at(-1),angle=Math.atan2(b.y-a.y,b.x-a.x);ctx.beginPath();ctx.moveTo(b.x-scrollX-15*Math.cos(angle-.5),b.y-scrollY-15*Math.sin(angle-.5));ctx.lineTo(b.x-scrollX,b.y-scrollY);ctx.lineTo(b.x-scrollX-15*Math.cos(angle+.5),b.y-scrollY-15*Math.sin(angle+.5));ctx.stroke();}
    }
    async function freezePage() {
      if (busy || editor.open || $('.ka-manager').open || $('.ka-codex').open || projectUI?.isOpen() || !enabled) return;
      if(batch.status==='archived'){notice('本批已归档，请先在清单中继续此批');return;}
      clearTimeout(freezeTimer); freezeTimer = null; releaseFreeze(); refreshBatch();
      const version = routeVersion, viewVersion = viewportVersion, viewport = viewportState(), pageKey = key(), batchSnapshot=storedSnapshot;
      const rects = Object.fromEntries(currentItems().map(item => [item.id,liveRect(item)]));
      const check = () => {
        store.assertUnchanged(batchSnapshot);
        if (viewVersion !== viewportVersion || pageKey !== key() || version !== routeVersion || JSON.stringify(viewport) !== JSON.stringify(viewportState())) throw Error('定格期间页面或视口已变化，请保持目标展开后重试');
      };
      let image, bitmap, elements;
      await locked(async () => {
        const visibility = host.style.visibility; host.style.setProperty('visibility','hidden','important');
        try {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          check(); image = await store.rpc('capture'); check();
          bitmap = await createImageBitmap(store.fromDataURL(image)); check();
          elements = [...document.querySelectorAll('button,h1,h2,h3,input,select,[data-action],a,p,img')].map(el=>store.describe(el)).filter(info=>{const r=info.rect;return r.width&&r.height&&r.x<scrollX+innerWidth&&r.x+r.width>scrollX&&r.y<scrollY+innerHeight&&r.y+r.height>scrollY;});
        } catch (error) { bitmap?.close(); throw error; }
        finally { host.style.visibility = visibility; }
      });
      const canvas = $('.ka-frozen'); canvas.width = viewport.width; canvas.height = viewport.height; canvas.style.width = viewport.width+'px'; canvas.style.height = viewport.height+'px';
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
      frozen = {image,viewport,pageKey,elements,rects,batchId:batch.batchId}; $('.ka-caption').textContent = '画面已定格'; canvas.hidden = false; root.dataset.frozen = 'true'; $('[data-action=unfreeze]').hidden = false;
      try { freezeStage.append(root); freezeStage.showModal(); setMode('region'); }
      catch (error) { releaseFreeze(); shadow.append(root); throw error; }
      notice('画面已定格，可以圈选、画笔或箭头；完成后自动恢复交互（Esc可退出）');
    }
    function delayedFreeze() {
      if (busy || editor.open) return;
      setMode('browse'); notice('3秒内展开弹窗或下拉菜单，并把鼠标停在目标上；Esc取消');
      freezeTimer = setTimeout(()=>{freezeTimer=null;freezePage().catch(error=>notice('定格失败：'+error.message));},3000);
    }
    async function screenshot(item) {
      const version = routeVersion, viewVersion = viewportVersion;
      const viewport = viewportState(), snapshot = draft?.snapshot;
      const check = () => {
        store.assertUnchanged(storedSnapshot);
        if (viewVersion !== viewportVersion || viewport.width !== innerWidth || viewport.height !== innerHeight || viewport.scrollX !== scrollX || viewport.scrollY !== scrollY || viewport.ratio !== devicePixelRatio || viewport.scale !== visualViewport?.scale) throw Error('截图期间视口已变化，草稿已保留，请保持页面位置后重试');
        if (snapshot && (snapshot.pageKey !== key() || JSON.stringify(snapshot.viewport) !== JSON.stringify(viewportState()))) throw Error('定格后的页面或视口已变化，草稿已保留；请返回原页面位置后保存');
        if (item.pageKey !== key() || version !== routeVersion) throw Error('截图期间页面已变化，草稿已保留，请返回批注页面后重试保存');
      };
      check();
      await libraries();
      check();
      const oldVisibility = host.style.visibility;
      host.style.setProperty('visibility', 'hidden', 'important');
      const previous = editor.style.visibility, previousDisplay = editor.style.display;
      editor.style.setProperty('visibility', 'hidden', 'important'); editor.style.setProperty('display', 'none', 'important');
      let bitmap;
      try {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const image = snapshot?.image || await store.rpc('capture');
        check(); bitmap = await createImageBitmap(store.fromDataURL(image));
      } finally {
        host.style.visibility = oldVisibility; editor.style.visibility = previous; editor.style.display = previousDisplay;
      }
      const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      check();
      const ctx=canvas.getContext('2d');
      for (const a of currentItems().concat(item)) { for(const s of a.shapes || []) paint(ctx,s); const r=liveRect(a,snapshot),x=Math.max(14,r.x-scrollX),y=Math.max(14,r.y-scrollY);ctx.fillStyle=getComputedStyle(root).getPropertyValue('--ka-ink').trim();ctx.beginPath();ctx.arc(x,y,13,0,Math.PI*2);ctx.fill();ctx.fillStyle=getComputedStyle(root).getPropertyValue('--ka-paper').trim();ctx.font='bold 13px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(a.id),x,y); }
      const blob = await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('截图生成失败')),'image/png'));
      check(); return blob;
    }
    async function saveDraft() {
      if (!draft || busy) return;
      const text=$('[name=text]').value.trim();if(!text){$('[name=text]').reportValidity();return;}
      $('.ka-editor-status').textContent='正在保存截图和批注…';
      const item={...draft,refs:[...draft.refs],text,category:$('[name=category]').value,status:$('[name=status]').value,observed:$('[name=observed]').value.trim(),expected:$('[name=expected]').value.trim(),reproduction:$('[name=reproduction]').value.trim(),updatedAt:new Date().toISOString()};delete item.existing;delete item.pendingRefs;delete item.removedRefs;delete item.snapshot;delete item.needsRebase;
      try {
        await locked(async () => {
          const newKeys = [];
          const check = () => {
            store.assertUnchanged(storedSnapshot);
            if(draft.needsRebase)throw Object.assign(Error('草稿版本已变化，请加载最新并另存，原批注保持不变'),{code:'KP_ANNOTATION_CONFLICT'});
            if (draft.batchId!==batch.batchId) throw Error('请先返回草稿批次后保存');
            if (!draft.existing && item.pageKey !== key()) throw Error('页面已变化，草稿已保留，请返回批注页面后重试保存');
          };
          try {
            check();
            if(!draft.existing){const blob=await screenshot(item);check();await store.putAsset(item.shot,blob);newKeys.push(item.shot);}
            for(let i=0;i<draft.pendingRefs.length;i++){const blob=await referenceImage(draft.pendingRefs[i]),ext=blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png',name=`refs/${String(item.id).padStart(3,'0')}-${Date.now()}-${i}.${ext}`;check();await store.putAsset(name,blob);newKeys.push(name);item.refs.push(name);}
            check();
            const next={...batch,annotations:draft.existing?batch.annotations.map(a=>a.id===item.id?item:a):batch.annotations.concat(item),nextId:draft.existing?batch.nextId:batch.nextId+1};
            await commit(next);
          } catch (error) { await store.clearAssets(newKeys).catch(()=>{}); throw error; }
          await store.clearAssets(draft.removedRefs).catch(()=>{});draft=null;editor.close();
        });
        setMode('browse');renderList();notice(`已保存 #${item.id} · 可切换页面继续批注`);
      } catch(error) { draftError(error); }
    }
    async function exportBatch() {
      if(busy)throw Error('请等待当前保存完成');
      if(!batch.annotations.length)throw Error('先保存至少一条批注');
      notice('正在打包批注和图片…');
      return locked(async () => {
        await libraries(); store.assertUnchanged(storedSnapshot);
        const blob=await store.buildZip(batch); store.assertUnchanged(storedSnapshot);
        renderList();return blob;
      });
    }
    function closeCodex() {
      if(busy)return;
      codexDialog.close();codexSnapshot=null;codexRequest=null;codexTarget='';codexTargetEdited=false;codexSubmitter=null;codexInput.value='';
      codexDialog.querySelector('a').hidden=true;codexDialog.querySelector('.ka-codex-status').textContent='';
      refreshBatch();renderMarks();renderList();
    }
    async function openCodex() {
      if (busy || editor.open) { notice('请先保存当前草稿，再发送本批'); return; }
      refreshBatch();
      if (!batch.annotations.length) { notice('请先保存至少一条批注'); return; }
      setMode('browse');
      const dialog = $('.ka-codex'), snapshot = codexSnapshot = storedSnapshot, request = codexRequest = {};
      codexTarget = ''; codexTargetEdited = false; codexSubmitter = null;
      dialog.querySelector('.ka-codex-summary').textContent = `${batch.projectName} / ${batch.name} · 全部 ${batch.annotations.length} 条（含被筛选隐藏的条目）`;
      dialog.querySelector('input').value = ''; dialog.querySelector('button[type=submit]').disabled = false;
      dialog.querySelector('.ka-codex-status').textContent = '正在读取本机接入与目标对话…';
      dialog.querySelector('a').hidden = true; dialog.showModal();
      try {
        const info = await store.rpc('codex-info', {expected: snapshot});
        if (codexRequest !== request || codexSnapshot !== snapshot || !dialog.open) return;
        store.assertUnchanged(snapshot);
        if (!codexTargetEdited) codexInput.value = codexTarget = info.threadId ? 'codex://threads/' + info.threadId : '';
        dialog.querySelector('.ka-codex-status').textContent = '本地接入已就绪。请核对目标对话后发送。';
        dialog.querySelector('input').focus();
      } catch (error) { if (codexRequest === request && codexSnapshot === snapshot && dialog.open) dialog.querySelector('.ka-codex-status').textContent = error.message; }
    }
    async function action(event) {
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.mode){setMode(button.dataset.mode);return;}
      if(button.dataset.id||button.dataset.edit){const a=batch.annotations.find(x=>x.id===Number(button.dataset.id||button.dataset.edit));if(a)openDraft(a,true);return;}
      if(button.dataset.delete){if(busy)return;const a=batch.annotations.find(x=>x.id===Number(button.dataset.delete));if(!a||!confirm(`删除批注 #${a.id}？`))return;try{await locked(async()=>{await commit({...batch,annotations:batch.annotations.filter(x=>x!==a)});await store.clearAssets([a.shot,...a.refs]);});renderMarks();renderList();}catch(e){notice('删除失败：'+e.message);}return;}
      const type=button.dataset.action;
      if(type==='adopt-category' || type==='dismiss-category') {
        if (!event.isTrusted || busy || !draft || !editor.open || !categorySuggestion ||
            categorySuggestion.key !== JSON.stringify(categoryInputs())) { renderCategorySuggestion(); return; }
        if (type === 'adopt-category') $('[name=category]').value = categorySuggestion.category;
        else dismissedSuggestionKey = categorySuggestion.key;
        renderCategorySuggestion(); return;
      }
      if(type==='list')toggleList();
      if(type==='freeze-delay')delayedFreeze();
      if(type==='unfreeze')setMode('browse');
      if(type==='close')toggle(false);
      if(type==='cancel'&&!busy){draft=null;editor.close();refreshBatch();setMode('browse');renderList();}
      if(type==='retry')await retryDraft();
      if(type==='return-draft'&&!busy&&draft){const url=new URL(draft.url);if(url.origin===location.origin&&url.pathname===location.pathname&&url.search===location.search)location.hash=url.hash;else draftError(Error('请将地址栏切回批注原页面的筛选状态后重试，当前草稿继续保留'));}
      if(type==='save')await saveDraft();
      if(type==='project'){setMode('browse');await projectUI.open();}
      if(type==='project-read')await projectUI.refresh({read:true});
      if(type==='codex')await openCodex();
      if(type==='codex-cancel')closeCodex();
      if(type==='export')try {const blob=await exportBatch(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`kepler-annotations-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);notice('已导出本批全部批注。完成本轮后可选择「归档并新建」。');}catch(e){notice('导出失败：'+e.message);}
      if(['clear','archive-new','new-project','new-batch','rename-project','rename-batch'].includes(type))openManagement(type);
      if(type==='manage-cancel'){$('.ka-manager').close();refreshBatch();renderMarks();renderList();}
      if(type==='resume')await manage({action:'resume'});
      if(type==='return-batch'&&draft&&!busy){draft.needsRebase=true;await store.withBatchLock(async()=>{await store.manage({action:'select',batchId:draft.batchId},store.rawSnapshot());refreshBatch();});renderMarks();draftError(Error('已返回草稿批次，原话已保留；请加载最新并另存。'),true);}
      if(type==='bulk-category'||type==='bulk-status'){
        const field=type==='bulk-category'?'category':'status',value=list.querySelector('[name='+type+']').value;
        if(!selected.size||!value){notice('请先选择批注和要设置的值');return;}
        await locked(()=>commit({...batch,annotations:batch.annotations.map(a=>selected.has(a.id)?{...a,[field]:value,updatedAt:new Date().toISOString()}:a)}));renderList();notice('已更新所选批注');
      }
    }
    function toggle(value=!enabled) { if(busy||projectUI?.isBusy())return;enabled=value;if(!enabled){draft=null;if(editor.open)editor.close();if($('.ka-codex').open)closeCodex();projectUI?.close();}root.hidden=!enabled;setMode('browse'); }
    codexInput.addEventListener('input',event=>{
      if(event.isTrusted){codexTarget=codexInput.value;codexTargetEdited=true;}
    });
    codexDialog.addEventListener('click',event=>{
      event.stopPropagation();
      if(!event.isTrusted)return;
      const button=event.target.closest('button');
      if(button?.type==='submit'){
        event.preventDefault();if(busy)return;
        codexSubmitter=button;
        try{button.form.requestSubmit(button);}finally{codexSubmitter=null;}
      }else action(event).catch(error=>notice(error.message));
    });
    $('.ka-codex form').addEventListener('submit',async event=>{
      event.preventDefault();if(!event.isTrusted||!codexSubmitter||event.submitter!==codexSubmitter||busy||!codexDialog.open)return;
      const dialog=$('.ka-codex'),status=dialog.querySelector('.ka-codex-status'),threadId=codexTarget;
      if(codexInput.value!==codexTarget){status.textContent='目标对话已变化，请重新输入目标对话后再点击发送。';return;}
      try {
        store.assertUnchanged(codexSnapshot);
        status.textContent='正在保存图片并交给 Codex，请等待排队回执…';
        const result=await locked(()=>store.rpc('codex-send',{expected:codexSnapshot,threadId,aiTasks:store.aiTasks(batch),markdown:store.markdown(batch)}));
        status.textContent=(result.duplicate?'此版本已交接，本次未重复发送。':'已加入目标对话的消息队列。')+' 本地证据：'+result.folder+(result.warning?' '+result.warning:'');
        const link=dialog.querySelector('a');link.href='codex://threads/'+result.threadId;link.hidden=false;
        dialog.querySelector('button[type=submit]').disabled=true;
      } catch(error){status.textContent=error.message;}
    });
    $('.ka-codex').addEventListener('cancel',event=>{
      event.preventDefault();closeCodex();
    });
    $('.ka-manager form').addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;const dialog=$('.ka-manager'),name=dialog.querySelector('input').value;
      try{store.assertUnchanged(managementSnapshot);await manage({action:managementAction==='clear'?'archive-new':managementAction,name});dialog.close();notice('已更新批次；存档可从批次列表找回');}catch(error){dialog.querySelector('[role=status]').textContent=error.message;}
    });
    $('.ka-manager').addEventListener('cancel',()=>{queueMicrotask(()=>{refreshBatch();renderMarks();renderList();});});
    list.addEventListener('change',event=>{
      const el=event.target;
      if(el.name==='filter-category'){categoryFilter=el.value;selected.clear();renderList();}
      if(el.name==='filter-status'){statusFilter=el.value;selected.clear();renderList();}
      if(el.dataset.select){el.checked?selected.add(Number(el.dataset.select)):selected.delete(Number(el.dataset.select));renderList();}
      if(el.name==='select-visible'){for(const a of batch.annotations.filter(a=>(!categoryFilter||a.category===categoryFilter)&&(!statusFilter||(a.status||'未处理')===statusFilter)))el.checked?selected.add(a.id):selected.delete(a.id);renderList();}
      if(el.name==='batch'||el.name==='project'){
        const batchId=el.name==='batch'?el.value:store.getCatalog().batches.find(b=>b.projectId===el.value)?.batchId;
        manage({action:'select',batchId}).catch(error=>{notice(error.message);renderList();});
      }
    });
    root.addEventListener('click',event=>{action(event).catch(e=>notice(e.message));});
    editor.addEventListener('input', event => {
      if (['text','observed','expected','reproduction'].includes(event.target?.name)) renderCategorySuggestion();
    });
    editor.addEventListener('change', event => {
      if (event.target?.name === 'category') renderCategorySuggestion();
    });
    $('[name=reference]').addEventListener('change',event=>addRefs(event.target.files));
    editor.addEventListener('paste',event=>{const files=[...(event.clipboardData?.items || [])].filter(x=>x.kind==='file').map(x=>x.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();addRefs(files);}});
    editor.addEventListener('cancel',event=>{event.preventDefault();if(!busy){draft=null;editor.close();refreshBatch();setMode('browse');renderList();}});
    editor.querySelector('form').addEventListener('submit',event=>{event.preventDefault();saveDraft();});
    document.addEventListener('keydown',event=>{
      if(event.altKey&&event.shiftKey&&event.code==='KeyS'&&enabled&&!editor.open){event.preventDefault();event.stopImmediatePropagation();freezePage().catch(error=>notice('定格失败：'+error.message));}
      else if(event.altKey&&event.code==='KeyA'){event.preventDefault();toggle();}
      else if(event.key==='Escape'&&!editor.open&&!$('.ka-manager').open&&!$('.ka-codex').open&&!projectUI?.isOpen()&&enabled){if(freezeStage.open){event.preventDefault();event.stopImmediatePropagation();}setMode('browse');}
    },true);
    freezeStage.addEventListener('cancel',event=>{if(event.target===freezeStage){event.preventDefault();if(!busy&&!editor.open)setMode('browse');}});
    document.addEventListener('pointermove',event=>{
      if(!enabled||busy||editor.open)return;
      if(drawing){drawing.points.push(point(event));renderMarks();return;}
      if(mode==='point'||mode==='reference'){const el=targetOf(event);if(!isTool(el))renderMarks(store.describe(el).rect);}
    },true);
    document.addEventListener('click',event=>{
      if(!enabled||busy||editor.open||$('.ka-manager').open||$('.ka-codex').open||projectUI?.isOpen()||!['point','reference'].includes(mode))return;const el=targetOf(event);if(isTool(el))return;
      event.preventDefault();event.stopImmediatePropagation();const info=store.describe(el);
      if(mode==='reference'){if(!reference){reference=info;notice('再点参照元素 · 改成像这个');renderMarks(info.rect);return;}openDraft(draftFor([reference,info],reference.rect));reference=null;}
      else openDraft(draftFor([info],info.rect));
    },true);
    layer.addEventListener('pointerdown',event=>{if(!enabled||busy||editor.open||$('.ka-manager').open||$('.ka-codex').open||projectUI?.isOpen()||!['region','pen','arrow'].includes(mode))return;event.preventDefault();drawing={type:mode,points:[point(event)]};layer.setPointerCapture(event.pointerId);});
    layer.addEventListener('pointerup',event=>{
      if(!drawing)return;event.preventDefault();drawing.points.push(point(event));const shape=drawing;drawing=null;
      const xs=shape.points.map(p=>p.x),ys=shape.points.map(p=>p.y),rect={x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
      if(rect.width+rect.height<6){renderMarks();return;}
      const elements=mode==='region'?(frozen?.elements||[...document.querySelectorAll('button,h1,h2,h3,input,select,[data-action],a,p,img')].map(el=>store.describe(el))).filter(info=>{const r=info.rect;return r.width&&r.height&&r.x<rect.x+rect.width&&r.x+r.width>rect.x&&r.y<rect.y+rect.height&&r.y+r.height>rect.y;}).slice(0,12):[];
      openDraft(draftFor(elements,rect,[mode==='region'?{type:'region',rect}:shape]));
    });
    layer.addEventListener('pointercancel',()=>{drawing=null;renderMarks();});
    let lastURL = location.href, renderPending = false;
    function pageChanged() {
      if (location.href === lastURL) return;
      lastURL = location.href; routeVersion++; reference = null; drawing = null; clearTimeout(freezeTimer); freezeTimer = null; releaseFreeze();
      if (editor.open) draftError(Error('页面已变化，草稿已保留，请返回批注页面后继续保存'));
      else setMode('browse');
      renderMarks(); renderList();
    }
    window.navigation?.addEventListener('currententrychange',pageChanged);
    addEventListener('hashchange',pageChanged);
    addEventListener('popstate',pageChanged);
    addEventListener('scroll',()=>{viewportVersion++;if(enabled)renderMarks();},true);addEventListener('resize',()=>{viewportVersion++;if(enabled)renderMarks();});
    visualViewport?.addEventListener('resize',()=>{viewportVersion++;});
    visualViewport?.addEventListener('scroll',()=>{viewportVersion++;});
    store.subscribe(() => {
      if (store.rawSnapshot() === storedSnapshot) return;
      if(store.load().batchId!==batch.batchId){selected.clear();releaseFreeze();}
      if($('.ka-codex').open){$('.ka-codex-status').textContent='其他标签页已更新批次，请关闭后重新打开，确保发送最新内容';renderMarks();return;}
      if($('.ka-manager').open){$('.ka-manager [role=status]').textContent='其他标签页已更新批次，请取消后重新打开此操作';renderMarks();return;}
      if(editor.open&&!busy&&draft)draft.needsRebase=true;
      if (editor.open || busy) { renderMarks(); if (editor.open && !busy) draftError(Object.assign(Error('其他标签页已更新批注，当前草稿已保留'), {code: 'KP_ANNOTATION_CONFLICT'})); return; }
      try { refreshBatch(); renderMarks(); renderList(); } catch(error) { notice(error.message); }
    });
    setInterval(pageChanged, 500);
    new MutationObserver(records => {
      if (!records.some(record => record.target !== host && !host.contains(record.target)) || renderPending) return;
      if (enabled && !busy && !editor.open) { renderPending = true; requestAnimationFrame(() => { renderPending = false; renderMarks(); }); }
    }).observe(document.documentElement, {childList: true, subtree: true});
    projectUI=globalThis.KPAnnotationProject.create({root,sheet,store,onChange:renderList,isReady:()=>!busy&&!editor.open&&!$('.ka-manager').open&&!$('.ka-codex').open,isVisible:()=>enabled&&!list.hidden});
    setMode('browse');renderList();window.KPAnnotate={ready:true,exportBatch,toggle};
  }
  start().finally(()=>{ window.KPAnnotateStarting = false; }).catch(error=>{const message=document.createElement('p');message.id='kp-annotate-error';message.setAttribute('role','alert');message.textContent='批注工具启动失败：'+error.message+'。已有本地数据已保留。';document.body.append(message);});
})();
