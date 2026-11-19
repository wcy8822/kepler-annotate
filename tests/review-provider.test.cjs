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
