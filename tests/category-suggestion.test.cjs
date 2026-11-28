'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({chrome: {storage: {onChanged: {addListener() {}}}}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../kp-annotate-store.js'),'utf8'),context);
const store = context.KPAnnotationStore;

test('本地规则覆盖五类明确反馈，仅给候选不修改原数据', () => {
  const cases = [
    ['左右间距不一致','视觉'],
    ['这里有错别字','文案'],
    ['点击后弹窗打不开','交互'],
    ['业务规则校验有误','产品逻辑'],
    ['建议新增导出功能','反馈/建议']
  ];
  for (const [text,category] of cases) {
    const item = {id:7, text, category:'视觉', refs:['refs/7.png']};
    const original = structuredClone(item);
    const candidate = store.suggestCategory(item);
    assert.equal(candidate.category,category);
    assert.equal(candidate.source,'local-rule');
    assert.deepEqual(item,original);
  }
});

test('多类别线索、不明确描述与空输入不生成自信结论', () => {
  for (const text of ['帮我看看','点击后布局重叠','文案颜色有问题','']) {
    assert.equal(store.suggestCategory({text}),null);
  }
  assert.equal(store.suggestCategory(null),null);
  assert.equal(store.suggestCategory({text:42}),null);
});

test('建议仅使用用户填写字段，忽略非文本和网页上下文', () => {
  assert.equal(store.suggestCategory({text:'',expected:'希望调整颜色'}).category,'视觉');
  assert.equal(store.suggestCategory({text:'',observed:'无法点击'}).category,'交互');
  assert.equal(store.suggestCategory({text:'',url:'https://example.com/错别字',elements:[{text:'错别字'}]}),null);
});
