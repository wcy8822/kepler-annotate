'use strict';

// 运行真实 controller 源；可控 RPC Promise 与手动时钟保证复现不依赖网络和等待时长。
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const controller = path.join(__dirname, '../kp-annotate-project.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

function binding(project) {
  return {binding: {projectId: project, projectName: project, projectRoot: '/test/' + project}};
}

function setup() {
  const listeners = [], timers = [], calls = [];
  let raw = 'project-A:batch-1', projectId = 'project-A';
  const input = {value: '', addEventListener() {}, focus() {}};
  const status = {textContent: ''}, target = {textContent: ''};
  const form = {addEventListener() {}};
  const dialog = {
    open: false,
    querySelector(selector) {
      assert.equal(selector, 'form');
      return form;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
  const nodes = {'dialog': dialog, 'input': input, '[role=status]': status, '.ka-project-target': target};
  const shadow = {querySelector(selector) {
    assert.ok(nodes[selector], '意外的 DOM 查询：' + selector);
    return nodes[selector];
  }};
  const store = {
    rawSnapshot: () => raw,
    load: () => ({projectId, projectName: projectId, batchId: 'batch-1', name: '批次一'}),
    subscribe: callback => listeners.push(callback),
    rpc(op, data) {
      assert.ok(['project-info', 'project-read'].includes(op), '测试未授权修改请求：' + op);
      return new Promise((resolve, reject) => calls.push({op, expected: data.expected, resolve, reject}));
    }
  };
  const context = vm.createContext({
    document: {createElement: () => ({attachShadow: () => shadow})},
    setInterval(callback) { timers.push(callback); return timers.length; }
  });
  vm.runInContext(fs.readFileSync(controller, 'utf8'), context, {filename: controller});
  const ui = context.KPAnnotationProject.create({
    root: {append() {}}, sheet: {}, store, onChange() {}, isReady: () => true, isVisible: () => true
  });
  return {
    ui, calls, status,
    switchProject(next) {
      projectId = next;
      raw = next + ':batch-1';
      listeners.forEach(callback => callback());
    },
    tick() { timers.forEach(callback => callback()); }
  };
}

test('跨项目刷新立即发起新请求，旧 ticket 完成不清除最新 reading 或覆盖结果', async () => {
  const f = setup();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].expected, 'project-A:batch-1');

  f.switchProject('project-B');
  assert.equal(f.calls.length, 2, 'A 仍在读取时，B 的刷新必须立即发起');
  assert.equal(f.calls[1].expected, 'project-B:batch-1');

  const latest = f.ui.refresh({read: true});
  assert.equal(f.calls.length, 3, '读取结果的显式请求必须成为最新 ticket');
  f.calls[2].resolve(binding('project-B'));
  await flush();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].op, 'project-read');
  assert.equal(f.calls[3].expected, 'project-B:batch-1');

  f.calls[0].resolve(binding('project-A'));
  f.calls[1].resolve(binding('project-B'));
  await flush();
  f.tick();
  assert.equal(f.calls.length, 4, '旧 ticket 的 finally 应保持最新读取忙碌，轮询不能抢占');

  const revision = 'b'.repeat(64);
  f.calls[3].resolve({items: [{id: 7, revision, result: {revision, status: '待确认', summary: 'B 的当前结果'}}]});
  await latest;
  assert.equal(f.ui.resultFor(7).summary, 'B 的当前结果');
  assert.match(f.ui.summary(), /1 条有处理记录/);

  f.tick();
  assert.equal(f.calls.length, 5, '最新 ticket 完成后，应恢复轮询');
  f.calls[4].resolve(binding('project-B'));
  await flush();
  assert.equal(f.calls[5].op, 'project-read');
  f.calls[5].resolve({items: [{id: 7, revision, result: {revision, status: '待确认', summary: 'B 的当前结果'}}]});
  await flush();
});

test('仅展示 result.revision 严格匹配条目版本的结果，缺失、空值和旧版本均过滤', async () => {
  const f = setup();
  f.calls[0].resolve(binding('project-A'));
  await flush();
  const reading = f.ui.refresh({read: true});
  f.calls[1].resolve(binding('project-A'));
  await flush();
  assert.equal(f.calls[2].op, 'project-read');

  const revision = 'a'.repeat(64);
  f.calls[2].resolve({items: [
    {id: 7, revision, result: {status: '待验收', summary: '缺版本结果'}},
    {id: 8, revision, result: {revision, status: '待验收', summary: '当前版本结果'}},
    {id: 9, revision, result: {revision: 'c'.repeat(64), status: '待验收', summary: '旧版本结果'}},
    {id: 10, revision, result: null},
    {id: 11, revision, result: {revision: '', status: '待验收', summary: '空版本结果'}}
  ]});
  await reading;

  assert.equal(f.ui.resultFor(7), undefined, '缺少 result.revision 的结果应过滤');
  assert.equal(f.ui.resultFor(8).summary, '当前版本结果');
  assert.equal(f.ui.resultFor(9), undefined);
  assert.equal(f.ui.resultFor(10), undefined);
  assert.equal(f.ui.resultFor(11), undefined);
  assert.match(f.ui.summary(), /1 条有处理记录/);
});
