'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAdapter,requestLocal} = require('../review-provider.js');
const HASH='a'.repeat(64);
const annotation={text:'标题遮挡', observed:'列表标题不可见',expected:'完整显示',
  url:'https://example.invalid/private?token=secret',shot:'shots/001.png',refs:['refs/a.png'],
  password:'never-send',elements:[{html:'sensitive'}]};
const result=(origin='test-double')=>({schemaVersion:1,origin,readOnly:true,proposal:'建议检查标题可见性',needsConfirmation:false});

test('真实运行入口只返回只读本地建议，保留来源哈希', async()=>{
  const suggestion=await requestLocal({annotation,sourceHash:HASH});
  assert.equal(suggestion.origin,'local-template');
  assert.equal(suggestion.sourceHash,HASH);
  assert.equal(suggestion.readOnly,true);
  assert.match(suggestion.proposal,/标题遮挡/);
  assert(!suggestion.proposal.includes('password'));
  assert(Object.isFrozen(suggestion));
});
test('测试替身仅接收四个已保存文本，不拿图片/URL/工具',async()=>{
  let seen;
  const adapter=createAdapter('test-double',async input=>{seen=input;return result();});
  assert.deepEqual(await adapter.request({annotation,sourceHash:HASH}),{...result(),sourceHash:HASH});
  assert.deepEqual(Object.keys(seen),['text','observed','expected','reproduction']);
  assert(Object.isFrozen(seen));
});
test('拒绝假 readOnly、额外 toolCalls、超长和伪造来源',async()=>{
  for(const invalid of [ {...result(),readOnly:false}, {...result(),toolCalls:[]},
      {...result(),origin:'model'}, {...result(),proposal:'x'.repeat(3001)},
      {...result(),needsConfirmation:'false'}, {...result(),schemaVersion:1,extra:true}]){
    const adapter=createAdapter('test-double',async()=>invalid);
    await assert.rejects(adapter.request({annotation,sourceHash:HASH}),{code:'KP_REVIEW_PROVIDER_RESPONSE'});
  }
});
test('无效来源、取消信号与批注类型都失败关闭', async()=>{
  await assert.rejects(requestLocal({annotation,sourceHash:'invalid'}),{code:'KP_REVIEW_PROVIDER_INPUT'});
  await assert.rejects(requestLocal({annotation:{text:['attack']},sourceHash:HASH}),{code:'KP_REVIEW_PROVIDER_INPUT'});
  const c=new AbortController();c.abort();
  await assert.rejects(requestLocal({annotation,sourceHash:HASH,signal:c.signal}),{code:'KP_REVIEW_PROVIDER_CANCELLED'});
});
test('请求取消立即返回，迟到的替身回复不会被采用',async()=>{
  let release;
  const adapter=createAdapter('test-double',()=>new Promise(resolve=>{release=()=>resolve(result());}));
  const c=new AbortController();
  const pending=adapter.request({annotation,sourceHash:HASH,signal:c.signal,timeoutMs:500});
  await new Promise(resolve=>setImmediate(resolve));
  c.abort();
  await assert.rejects(pending,{code:'KP_REVIEW_PROVIDER_CANCELLED'});
  release();
});
test('超时拒绝不响应取消的替身，不能把迟到结果送入编辑器',async()=>{
  let release;
  const adapter=createAdapter('test-double',()=>new Promise(resolve=>{release=()=>resolve(result());}));
  await assert.rejects(adapter.request({annotation,sourceHash:HASH,timeoutMs:10}),{code:'KP_REVIEW_PROVIDER_TIMEOUT'});
  release();
});
test('Provider 抛错不变更原始输入',async()=>{
  const adapter=createAdapter('test-double',()=>{throw Error('mock provider failed');});
  await assert.rejects(adapter.request({annotation,sourceHash:HASH}),/mock provider failed/);
  assert.equal(annotation.text,'标题遮挡');
});

test('Native 合成适配器默认关闭，并核验主机能力',async()=>{
  const {createNativeFixtureAdapter}=require('../review-provider.js');
  assert.throws(()=>createNativeFixtureAdapter(async()=>{}),{code:'KP_REVIEW_PROVIDER_CONFIG'});
  const messages=[];
  const adapter=createNativeFixtureAdapter(async m=>{messages.push(m);return {ok:true,capabilities:{reviewPreviewLifecycle:'disabled'}};},{enabled:true});
  await assert.rejects(adapter.request({annotation,sourceHash:HASH}),{code:'KP_REVIEW_PROVIDER_CONFIG'});
  assert.deepEqual(messages,[{op:'info'}]);
});
test('Native 合成适配器真实子进程通信：请求、轮询、独立执行及来源一致',async()=>{
  const {createNativeFixtureAdapter}=require('../review-provider.js');
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {spawnSync}=require('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kepler-native-review-fixture-'));
  const config=path.join(root,'fixture.json');
  fs.writeFileSync(config,JSON.stringify({dataRoot:path.join(root,'state'),enableSyntheticReviewFixture:true}),{mode:0o600});
  const host=path.join(__dirname,'..','native-host.py');
  const env={...process.env,KEPLER_ANNOTATE_CONFIG:config};
  const python=process.env.KEPLER_TEST_PYTHON||'python3';
  const messages=[];
  function run(args,input){
    const p=spawnSync(python,['-B',host,...args],{env,input,timeout:5000});
    assert.ifError(p.error);assert.equal(p.status,0,p.stderr?.toString());return p.stdout;
  }
  try{
    let worked=false;
    const adapter=createNativeFixtureAdapter(async m=>{
      messages.push(m);
      const body=Buffer.from(JSON.stringify(m)),header=Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      const frame=run([],Buffer.concat([header,body]));
      assert.equal(frame.readUInt32LE(0),frame.length-4);
      const reply=JSON.parse(frame.subarray(4).toString());
      if(m.op==='review-preview-status'&&reply.state==='queued'&&!worked){
        const worker=JSON.parse(run(['--synthetic-review-worker-once']).toString());
        assert.equal(worker.processed,true);assert.equal(worker.requestId,m.requestId);worked=true;
      }
      return reply;
    },{enabled:true,pollMs:1});
    const candidate=await adapter.request({annotation,sourceHash:HASH,timeoutMs:10000});
    assert.equal(candidate.origin,'native-fixture');assert.equal(candidate.readOnly,true);
    assert.equal(candidate.needsConfirmation,true);assert.equal(candidate.sourceHash,HASH);
    assert.match(candidate.proposal,/合成测试/);
    assert.deepEqual(messages.map(m=>m.op),['info','review-preview-request','review-preview-status','review-preview-status']);
    assert.deepEqual(Object.keys(messages[1]).sort(),['op','provider','requestId','sourceHash','synthetic']);
    assert(!JSON.stringify(messages).includes(annotation.text));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Native 合成适配器拒绝错来源结果并尽力取消',async()=>{
  const {createNativeFixtureAdapter}=require('../review-provider.js');
  const calls=[];
  const adapter=createNativeFixtureAdapter(async m=>{
    calls.push(m);
    if(m.op==='info')return {ok:true,capabilities:{reviewPreviewLifecycle:'synthetic_fixture_only'}};
    const base={ok:true,synthetic:true,requestId:m.requestId};
    if(m.op==='review-preview-request')return {...base,provider:'synthetic-fixture',duplicate:false,state:'queued'};
    if(m.op==='review-preview-status')return {...base,state:'completed',candidate:{...result('native-fixture'),needsConfirmation:true,sourceHash:'b'.repeat(64)}};
    return {...base,state:'cancelled',cancelled:true};
  },{enabled:true,pollMs:1});
  await assert.rejects(adapter.request({annotation,sourceHash:HASH}),{code:'KP_REVIEW_PROVIDER_RESPONSE'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.at(-1).op,'review-preview-cancel');
});
test('Native 合成适配器提交中取消：迟到确认后才发送取消',async()=>{
  const {createNativeFixtureAdapter}=require('../review-provider.js');
  const calls=[];let acknowledge,submitted;
  const started=new Promise(resolve=>{submitted=resolve;});
  const adapter=createNativeFixtureAdapter(async m=>{
    calls.push(m);
    if(m.op==='info')return {ok:true,capabilities:{reviewPreviewLifecycle:'synthetic_fixture_only'}};
    if(m.op==='review-preview-request')return new Promise(resolve=>{acknowledge=()=>resolve({ok:true,synthetic:true,requestId:m.requestId,provider:'synthetic-fixture',duplicate:false,state:'queued'});submitted();});
    return {ok:true,synthetic:true,requestId:m.requestId,state:'cancelled',cancelled:true};
  },{enabled:true,pollMs:1});
  const c=new AbortController();
  const pending=adapter.request({annotation,sourceHash:HASH,signal:c.signal});
  await started;c.abort();
  await assert.rejects(pending,{code:'KP_REVIEW_PROVIDER_CANCELLED'});
  assert.deepEqual(calls.map(m=>m.op),['info','review-preview-request']);
  acknowledge();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(m=>m.op),['info','review-preview-request','review-preview-cancel']);
});
