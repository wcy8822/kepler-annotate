(() => {
  'use strict';
  if (globalThis.KPAnnotationProject) return;
  globalThis.KPAnnotationProject = {create({root, sheet, store, onChange, isReady, isVisible}) {
    const host=document.createElement('div'),shadow=host.attachShadow({mode:'closed'});
    shadow.adoptedStyleSheets=[sheet];root.append(host);
    shadow.innerHTML=`<div id="kp-annotate-root"><dialog class="ka-project ka-codex" aria-label="项目本地存储"><form><h2>项目本地存储</h2><p class="ka-project-target"></p><p>将本项目批次和截图同步到项目目录，AI 可通过 Skill 查询增量并回写结果。首次绑定后，每次保存和管理批次会自动同步；浏览器副本继续保留。</p><label>本地项目目录<input name="project-root" placeholder="填写 Git 项目的完整路径" autocomplete="off"></label><p>批注保存在项目的 .kepler-annotate/，通过 Git 本地忽略规则保留在本机。AI 修改后先显示待验收，由你确认完成。</p><p role="status"></p><footer><button type="button" data-project="close">关闭</button><button type="button" data-project="read">读取 AI 结果</button><button type="button" data-project="sync">同步当前批次</button><button type="button" data-project="bind">绑定并同步项目</button></footer></form></dialog></div>`;
    const dialog=shadow.querySelector('dialog'),input=shadow.querySelector('input'),status=shadow.querySelector('[role=status]');
    let expected=null,typedPath='',busy=false,request=null,lastRaw=null,results=new Map(),currentProject=null,info=null,message='尚未绑定项目目录',reading=false,pathEdited=false;
    const unchanged=raw=>store.rawSnapshot()===raw;
    function clearResults(){lastRaw=null;results.clear();}
    function changed(){onChange();}
    function setBusy(value){busy=value;dialog.querySelectorAll('input,button').forEach(el=>el.disabled=value);}
    function assertDialog(){if(!unchanged(expected))throw Error('其他标签页已更新批次，请关闭后重新打开；批注已保留');}
    async function refresh({read=false}={}) {
      const raw=store.rawSnapshot(),batch=store.load(),ticket={};
      reading=true;request=ticket;
      if(currentProject!==batch.projectId){currentProject=batch.projectId;info=null;clearResults();}
      try {
        const next=await store.rpc('project-info',{expected:raw});
        if(request!==ticket||!unchanged(raw))return;
        info=next;message=next.binding?'已绑定：'+next.binding.projectRoot:'尚未绑定项目目录';
        if(next.sync?.state==='error')message='浏览器批注已保留；项目同步待重试：'+next.sync.message;
        if(read&&next.binding){
          const data=await store.rpc('project-read',{expected:raw});
          if(request!==ticket||!unchanged(raw))return;
          lastRaw=raw;results=new Map((data.items||[]).filter(item=>item.result&&typeof item.revision==='string'&&item.result.revision===item.revision).map(item=>[item.id,item.result]));
          message='已同步本批并读取 AI 结果 · '+results.size+' 条有处理记录';
        }
        if(dialog.open&&expected===raw){if(!pathEdited)input.value=typedPath=next.binding?.projectRoot||typedPath;status.textContent=message;}
      } catch(error){if(request===ticket&&unchanged(raw)){clearResults();message='浏览器批注已保留；'+error.message;if(dialog.open)status.textContent=message;}}
      finally{if(request===ticket)reading=false;changed();}
    }
    async function open(){
      if(!isReady())return;
      expected=store.rawSnapshot();pathEdited=false;typedPath='';input.value='';
      shadow.querySelector('.ka-project-target').textContent=store.load().projectName+' / '+store.load().name;
      status.textContent='正在读取本机项目设置…';dialog.showModal();
      await refresh();
      if(dialog.open)input.focus();
    }
    function close(){if(busy)return false;dialog.close();expected=null;typedPath='';input.value='';return true;}
    input.addEventListener('input',event=>{if(event.isTrusted){pathEdited=true;typedPath=input.value;}});
    dialog.querySelector('form').addEventListener('submit',event=>event.preventDefault());
    dialog.addEventListener('click',async event=>{
      event.stopPropagation();if(!event.isTrusted||busy)return;
      const action=event.target.closest('button')?.dataset.project;
      if(!action)return;if(action==='close'){close();return;}
      try{
        assertDialog();
        if(action==='bind'&&(!typedPath.trim()||typedPath!==input.value))throw Error('请亲自填写项目的完整路径后再绑定');
        setBusy(true);status.textContent='正在同步项目，请等待本地写入回执…';
        if(action==='bind')await store.rpc('project-bind',{expected,projectRoot:typedPath.trim()});
        else if(action==='sync')await store.rpc('project-sync',{expected});
        assertDialog();await refresh({read:true});
        if(info?.binding)status.textContent=message;
      }catch(error){clearResults();message='浏览器批注已保留；'+error.message;status.textContent=message;changed();}
      finally{setBusy(false);}
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    store.subscribe(()=>{clearResults();if(dialog.open)status.textContent='批次已变化，请关闭后重新打开；当前输入和批注已保留';changed();if(!busy&&!dialog.open)refresh().catch(()=>{});});
    setInterval(()=>{if(info?.binding&&!dialog.open&&!busy&&!reading&&isReady()&&isVisible())refresh({read:true}).catch(()=>{});},5000);
    refresh().catch(()=>{});
    return {open,close,isOpen:()=>dialog.open,isBusy:()=>busy,refresh,resultFor:id=>unchanged(lastRaw)?results.get(id):null,summary:()=>currentProject===store.load().projectId?message:'尚未读取项目设置'};
  }};
})();
