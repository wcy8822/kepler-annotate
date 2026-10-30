'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {chromium, browserExecutablePath, pythonExecutable, temporaryDirectory} = require('./helpers.cjs');

// All writable application, browser, native and Git data belong to this run.
const source = path.resolve(__dirname, '..');
const output = temporaryDirectory('project-local-e2e');
const repo = path.join(output, 'repository');
const hostDir = path.join(output, 'host');
const extension = path.join(output, 'extension');
const profile = path.join(output, 'chrome-profile');
const config = path.join(hostDir, 'native-host-config.json');
const hostName = 'com.kepler.annotate_e2e_' + crypto.randomBytes(8).toString('hex');
const queueGuard = path.join(hostDir, 'queue-forbidden.py');
const queueMarker = path.join(output, 'FORBIDDEN-QUEUE');
const report = {status: 'running', output, repo, profile, hostName, checks: [], commands: [], sourceHashes: {}};
let context, worker, cdp, page, extensionId, userManifest, manifestText, server, registryHome;
const env = {...process.env, KEPLER_ANNOTATE_CONFIG: config, PYTHONDONTWRITEBYTECODE: '1'};
delete env.CODEX_THREAD_ID;
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
env.GIT_CONFIG_NOSYSTEM = '1';
env.GIT_CONFIG_GLOBAL = '/dev/null';
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), {mode: 0o600});
const record = () => writeJSON(path.join(output, 'report.json'), report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(executable, args, {allowFailure = false, cwd = repo} = {}) {
  const result = spawnSync(executable, args, {cwd, env, encoding: 'utf8', timeout: 30000});
  const entry = {command: [executable, ...args], cwd, exitCode: result.status, stdout: result.stdout, stderr: result.stderr};
  report.commands.push(entry); record();
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0, JSON.stringify(entry));
  return entry;
}
const git = (...args) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args]).stdout.trim();
function cli(args, name, allowFailure = false) {
  const result = command(pythonExecutable(), ['-B', path.join(hostDir, 'kepler-annotations.py'), ...args], {allowFailure});
  const data = JSON.parse(result.stdout);
  writeJSON(path.join(output, name + '.json'), {exitCode: result.exitCode, ...data});
  return {...result, data};
}
async function eventually(predicate, message, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(100); }
  assert.fail(message);
}
async function check(name, fn) {
  try {
    const evidence = await fn(); report.checks.push({name, status: 'pass', evidence}); console.log('PASS', name);
  } catch (error) {
    report.checks.push({name, status: 'fail', error: error.stack}); throw error;
  } finally { record(); }
}
async function browserBatch() {
  return worker.evaluate(async () => { const key = ['kp', 'annotate', 'batch', 'v1'].join('-'); return JSON.parse((await chrome.storage.local.get(key))[key]); });
}
async function inject() {
  await page.bringToFront();
  const {targetInfos} = await cdp.send('Target.getTargets', {filter: [{type: 'tab', exclude: false}]});
  const target = targetInfos.find(t => t.url === page.url());
  assert(target); await cdp.send('Extensions.triggerAction', {id: extensionId, targetId: target.targetId});
  await page.locator('#kp-annotate-host .ka-toolbar').waitFor();
}
// Closed-shadow access is acceptance instrumentation only; all actions use trusted mouse/keyboard input.
async function projectDialog() {
  const session = await context.newCDPSession(page);
  async function node(selector) {
    const {root} = await session.send('DOM.getDocument', {depth: -1, pierce: true});
    function find(n) {
      if (n.nodeName === 'DIALOG' && n.attributes?.some((v, i) => i % 2 === 0 && v === 'class' && n.attributes[i + 1].split(' ').includes('ka-project'))) return n;
      for (const child of [...(n.children || []), ...(n.shadowRoots || [])]) { const found = find(child); if (found) return found; }
    }
    const dialog = find(root); assert(dialog, 'closed 项目 dialog 存在');
    const id = selector ? (await session.send('DOM.querySelector', {nodeId: dialog.nodeId, selector})).nodeId : dialog.nodeId;
    assert(id, '项目控件存在：' + selector); return id;
  }
  function view(selector = '') {
    async function read(fn) {
      const {object} = await session.send('DOM.resolveNode', {nodeId: await node(selector)});
      try {
        const result = await session.send('Runtime.callFunctionOn', {objectId: object.objectId, functionDeclaration: 'function(){return (' + fn.toString() + ')(this);}', returnByValue: true});
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
      } finally { await session.send('Runtime.releaseObject', {objectId: object.objectId}); }
    }
    async function click() {
      const p = await read(el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; });
      await page.mouse.click(p.x, p.y);
    }
    return {read, click, locator: s => view(selector ? selector + ' ' + s : s),
      fill: async text => { await click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text); },
      wait: text => eventually(async () => (await read(el => el.textContent)).includes(text), '项目弹窗等待：' + text)};
  }
  return view();
}

async function run() {
  for (const folder of [repo, hostDir, extension, profile]) fs.mkdirSync(folder, {mode: 0o700});
  const extensionFiles = ['manifest.json', 'service-worker.js', 'kp-annotate-store.js', 'kp-annotate-project.js', 'kp-annotate.js', 'kp-annotate.css'];
  for (const name of [...extensionFiles, 'native-host.py', 'project_store.py', 'kepler-annotations.py', 'install-native-host.py']) {
    report.sourceHashes[name] = hash(path.join(source, name));
    fs.copyFileSync(path.join(source, name), path.join(name.endsWith('.py') ? hostDir : extension, name));
  }
  fs.cpSync(path.join(source, 'vendor'), path.join(extension, 'vendor'), {recursive: true});
  // Only the temporary worker maps the host name. No native project response is fabricated.
  const bootstrap = `(() => {
    const send = chrome.runtime.sendNativeMessage.bind(chrome.runtime);
    globalThis.__projectE2ECalls = [];
    chrome.runtime.sendNativeMessage = (host, message, ...rest) => {
      if (host !== 'com.kepler.annotate' || !['project-info','project-bind','project-sync','project-read'].includes(message.op)) throw Error('E2E permits project RPC only');
      globalThis.__projectE2ECalls.push({op:message.op,projectId:message.projectId||message.batch?.projectId,batchId:message.batchId||message.batch?.batchId});
      return send(${JSON.stringify(hostName)}, message, ...rest);
    };
  })();\n`;
  fs.writeFileSync(path.join(extension, 'service-worker.js'), bootstrap + fs.readFileSync(path.join(extension, 'service-worker.js'), 'utf8'));
  fs.chmodSync(path.join(hostDir, 'native-host.py'), 0o700);
  const pythonPath = command(pythonExecutable(), ['-c', 'import sys; print(sys.executable)']).stdout.trim();
  fs.writeFileSync(queueGuard, '#!' + pythonPath + '\nfrom pathlib import Path\nPath(' + JSON.stringify(queueMarker) + ').write_text("unexpected codex invocation")\nraise SystemExit(97)\n', {mode: 0o700});
  const oldTitle = '本地验收旧标题', newTitle = '本地验收新标题';
  const originalComment = '请把页面主标题从“' + oldTitle + '”改为“' + newTitle + '”。';
  const changedComment = '需求已变：请把页面主标题改为“第三个标题”。';
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地项目闭环</title><h1>' + oldTitle + '</h1><p>仅临时 fixture</p></html>\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), "const assert=require('node:assert/strict'),fs=require('node:fs');\nassert.match(fs.readFileSync('index.html','utf8'),/<h1>本地验收新标题<\\/h1>/);\nconsole.log('fixture title check passed');\n");
  git('init', '-q'); git('config', 'user.name', 'Kepler E2E'); git('config', 'user.email', 'kepler-e2e@example.invalid');
  git('add', 'index.html', 'check.cjs'); git('commit', '-qm', 'test: isolated fixture baseline');
  report.baselineCommit = git('rev-parse', 'HEAD');
  server = http.createServer((req, res) => {
    if (req.url === '/BUILD.json') { res.writeHead(200, {'Content-Type': 'application/json'}); return res.end('{"test":"isolated-local-e2e"}'); }
    res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'}); res.end(fs.readFileSync(path.join(repo, 'index.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chrome = browserExecutablePath();
  context = await chromium.launchPersistentContext(profile, {executablePath: chrome, headless: true,
    args: ['--enable-unsafe-extension-debugging', '--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: {width: 1440, height: 1000}});
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = worker.url().split('/')[2];
  cdp = await context.browser().newBrowserCDPSession(); report.extensionId = extensionId;
  // Exercise the public installer with a real extension ID and its installing-Python launcher.
  const installed = JSON.parse(command(pythonExecutable(), ['-B', path.join(hostDir, 'install-native-host.py'),
    '--extension-id', extensionId, '--config-root', path.join(output, 'support'), '--codex-path', queueGuard]).stdout);
  assert.equal(installed.ok, true); assert.equal(path.resolve(installed.config), config);
  const installedConfig = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(installedConfig.defaultThread, null); assert.equal(installedConfig.codexPath, queueGuard);
  assert(path.resolve(installed.launcher).startsWith(hostDir + path.sep), 'launcher 留在隔离主机目录');
  registryHome = path.dirname(installedConfig.dataRoot); report.installer = installed;
  manifestText = JSON.stringify({name: hostName, description: 'Isolated Kepler project E2E', path: installed.launcher, type: 'stdio', allowed_origins: ['chrome-extension://' + extensionId + '/']}, null, 2);
  const hosts = path.join(profile, 'NativeMessagingHosts'); fs.mkdirSync(hosts, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(hosts, hostName + '.json'), manifestText, {mode: 0o600});
  await check('真实 Native host 注册与隔离配置', async () => {
    const probe = () => worker.evaluate(() => chrome.runtime.sendNativeMessage('com.kepler.annotate', {op: 'project-info', projectId: 'isolation-probe'}));
    try { report.profileProbe = await probe(); report.registration = 'profile'; }
    catch (error) {
      report.profileProbe = {error: error.message};
      assert.match(error.message, /not found|not registered|Specified native messaging host/i, '仅 host 查找失败时启用用户已授权的独有测试注册');
      const location = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
      fs.mkdirSync(location, {recursive: true}); userManifest = path.join(location, hostName + '.json');
      fs.writeFileSync(userManifest, manifestText, {mode: 0o600, flag: 'wx'});
      report.registration = 'unique-user-host-fallback'; report.userManifest = userManifest;
      report.nativeProbe = await probe();
    }
    const info = report.nativeProbe || report.profileProbe;
    assert.equal(info.ok, true); assert.equal(info.binding, null);
    const registryFile = path.join(registryHome, 'projects.json');
    if (fs.existsSync(registryFile)) assert.deepEqual(JSON.parse(fs.readFileSync(registryFile)).projects, {});
    assert(fs.existsSync(path.join(registryHome, '.projects.lock')), '真实 host 已在隔离配置目录执行');
    return {registration: report.registration, probe: info, registry: registryFile, launcher: installed.launcher};
  });
  page = await context.newPage(); await page.goto('http://127.0.0.1:' + server.address().port + '/'); await inject();
  const ui = page.locator('#kp-annotate-host');
  await ui.locator('[data-action=list]').first().click();
  const dialog = await projectDialog();
  await check('真实键鼠绑定临时 Git 项目并同步空批次', async () => {
    await ui.locator('[data-action=project]').click(); await dialog.wait('尚未绑定');
    await dialog.locator('input').fill(repo); await dialog.locator('[data-project=bind]').click(); await dialog.wait('已同步本批并读取');
    await eventually(() => dialog.locator('[data-project=close]').read(el => !el.disabled), '绑定完成恢复控件');
    await dialog.locator('[data-project=close]').click();
    const batch = await browserBatch(); report.projectId = batch.projectId; report.batchId = batch.batchId;
    const projects = cli(['projects'], 'cli-projects').data;
    assert.equal(projects.projects.length, 1); assert.equal(projects.projects[0].projectRoot, repo);
    assert.equal(projects.projects[0].projectId, batch.projectId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(registryHome, 'projects.json'))).projects[batch.projectId].projectRoot, repo);
    report.emptyRevision = cli(['read', '--project', batch.projectId, '--batch', batch.batchId], 'cli-read-empty').data.revision;
    return {projectId: batch.projectId, batchId: batch.batchId, projectRoot: repo};
  });
  let firstRead, originalItem;
  const readArgs = ['read', '--project', report.projectId, '--batch', report.batchId];
  await check('UI 保存原话与真实截图，CLI 从 Native 快照读取完整证据', async () => {
    await ui.locator('[data-mode=point]').click(); await page.locator('h1').click();
    await ui.locator('[name=text]').fill(originalComment); await ui.locator('[data-action=save]').click(); await ui.locator('.ka-editor').waitFor({state: 'hidden'});
    await eventually(async () => {
      const state = await worker.evaluate(async () => (await chrome.storage.local.get('kp-annotate-project-sync-v1'))['kp-annotate-project-sync-v1']);
      return state?.[report.projectId]?.state === 'synced' && state[report.projectId].revision !== report.emptyRevision && (await browserBatch()).annotations.length === 1;
    }, '浏览器保存与自动 native 同步完成');
    firstRead = cli(readArgs, 'cli-read-original').data; assert.equal(firstRead.items.length, 1); originalItem = firstRead.items[0];
    assert.equal(originalItem.rawComment, originalComment); assert.equal(originalItem.task.rawComment, originalComment); assert.equal(originalItem.result, null);
    assert.equal(originalItem.needsWork, true); assert.equal(originalItem.id, 1);
    assert(fs.readFileSync(path.join(firstRead.folder, 'annotations.md'), 'utf8').includes(originalComment));
    assert.equal(path.resolve(originalItem.evidence.screenshot), path.join(firstRead.folder, originalItem.annotation.shot));
    const png = fs.readFileSync(originalItem.evidence.screenshot); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert(png.length > 100);
    const assets = await worker.evaluate(async annotation => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('kp-annotate-extension-assets-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise((resolve, reject) => { const r = db.transaction('assets').objectStore('assets').get('batches/' + encodeURIComponent(annotation.batchId) + '/' + annotation.shot); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); }
    }, {batchId: report.batchId, shot: originalItem.annotation.shot});
    assert.equal(hash(originalItem.evidence.screenshot), crypto.createHash('sha256').update(Buffer.from(assets.split(',')[1], 'base64')).digest('hex'));
    assert.equal(await ui.locator('.ka-ai-result').count(), 0);
    await page.screenshot({path: path.join(output, '01-saved.png')});
    return {id: originalItem.id, itemRevision: originalItem.revision, batchRevision: firstRead.revision, screenshot: originalItem.evidence.screenshot, bytes: png.length};
  });
  let commit, resultArgs;
  const branch = 'codex/project-local-e2e';
  await check('原话生成需求 Markdown，codex 分支真实检查先红后绿并提交', async () => {
    const requirements = '# 批注需求\n\n项目：' + report.projectId + '\n\n批次：' + report.batchId + '\n\n## #' + originalItem.id + '\n\n原话：' + originalItem.rawComment + '\n\n版本：' + originalItem.revision + '\n\n证据：' + originalItem.evidence.screenshot + '\n\n验收：主标题为“' + newTitle + '”，执行 node check.cjs 通过。\n';
    fs.writeFileSync(path.join(repo, 'requirements.md'), requirements);
    git('switch', '-c', branch);
    const red = command(process.execPath, ['check.cjs'], {allowFailure: true}); assert.notEqual(red.exitCode, 0); assert.match(red.stderr, /AssertionError/);
    fs.writeFileSync(path.join(repo, 'index.html'), fs.readFileSync(path.join(repo, 'index.html'), 'utf8').replace('<h1>' + oldTitle + '</h1>', '<h1>' + newTitle + '</h1>'));
    const green = command(process.execPath, ['check.cjs']); assert.match(green.stdout, /fixture title check passed/);
    writeJSON(path.join(output, 'checks.json'), [{command: 'node check.cjs', exitCode: green.exitCode, stdout: green.stdout}]);
    git('add', 'index.html', 'requirements.md'); git('commit', '-qm', 'fix(fixture): apply annotation title request'); commit = git('rev-parse', 'HEAD');
    assert.equal(git('branch', '--show-current'), branch); assert.equal(git('status', '--porcelain'), '');
    report.commit = commit; report.branch = branch;
    const view = await context.newPage(); await view.goto(page.url()); assert.equal(await view.locator('h1').textContent(), newTitle); await view.close();
    return {requirements: path.join(repo, 'requirements.md'), branch, commit, redExit: red.exitCode, greenExit: green.exitCode, executor: 'deterministic test runner; no model or queue invoked'};
  });
  await check('真实 CLI result 回写并由 UI 显示待验收与提交证据', async () => {
    resultArgs = ['result', '--project', report.projectId, '--batch', report.batchId, '--id', String(originalItem.id), '--revision', originalItem.revision,
      '--status', '待验收', '--summary', '标题已按原话修改，检查通过，等待人工验收', '--branch', branch, '--commit', commit,
      '--checks-file', path.join(output, 'checks.json'), '--requirements', 'requirements.md'];
    const result = cli(resultArgs, 'cli-result').data; assert.equal(result.ok, true); assert.equal(result.result.status, '待验收');
    const read = cli(readArgs, 'cli-read-result').data; assert.equal(read.items[0].result.commit, commit); assert.equal(read.items[0].result.revision, originalItem.revision);
    await page.bringToFront(); await ui.locator('[data-action=project-read]').click();
    await ui.locator('.ka-ai-result').filter({hasText: '待验收'}).waitFor();
    const text = await ui.locator('.ka-ai-result').textContent(); assert(text.includes(commit)); assert(text.includes(branch)); assert(text.includes('等待人工验收')); assert(text.includes('node check.cjs'));
    assert((await ui.locator('article a').first().textContent()).includes('未处理'));
    assert.equal((await browserBatch()).annotations[0].text, originalComment);
    await page.screenshot({path: path.join(output, '02-awaiting-acceptance.png')});
    return {status: result.result.status, branch, commit, annotationStatus: (await browserBatch()).annotations[0].status};
  });
  await check('修改原话后 UI 清除旧结果，Native 新快照不再关联旧 revision', async () => {
    await ui.locator('[data-edit="1"]').click(); await ui.locator('[name=text]').fill(changedComment);
    await ui.locator('[data-action=save]').click(); await ui.locator('.ka-editor').waitFor({state: 'hidden'});
    assert.equal(await ui.locator('.ka-ai-result').count(), 0);
    await ui.locator('[data-action=project-read]').click();
    await eventually(async () => (await ui.locator('.ka-project-summary').textContent()).includes('0 条有处理记录'), '新原话读取无旧结果');
    const latest = cli(readArgs, 'cli-read-modified').data;
    assert.equal(latest.items[0].rawComment, changedComment); assert.notEqual(latest.items[0].revision, originalItem.revision); assert.notEqual(latest.revision, firstRead.revision);
    assert.equal(latest.items[0].result, null); assert.equal(latest.items[0].needsWork, true); assert.equal(await ui.locator('.ka-ai-result').count(), 0);
    assert(fs.existsSync(originalItem.evidence.screenshot));
    await page.screenshot({path: path.join(output, '03-revision-invalidated.png')});
    return {oldRevision: originalItem.revision, newRevision: latest.items[0].revision, result: latest.items[0].result};
  });
  await check('真实 CLI 拒绝旧 revision 回写，浏览器原话与待处理状态保留', async () => {
    const stale = cli(resultArgs, 'cli-stale-result', true); assert.equal(stale.exitCode, 1); assert.equal(stale.data.ok, false); assert.equal(stale.data.code, 'STALE_ITEM_REVISION');
    const latest = cli(readArgs, 'cli-read-after-rejection').data; assert.equal(latest.items[0].result, null); assert.equal(latest.items[0].rawComment, changedComment);
    await ui.locator('[data-action=project-read]').click();
    await eventually(async () => (await ui.locator('.ka-project-summary').textContent()).includes('0 条有处理记录'), '拒绝后保持无结果');
    assert.equal(await ui.locator('.ka-ai-result').count(), 0); assert((await ui.locator('article a').first().textContent()).includes('未处理'));
    assert.equal((await browserBatch()).annotations[0].text, changedComment);
    return {exitCode: stale.exitCode, code: stale.data.code};
  });
  await check('隔离范围与真实传输记录，无 queue 或主源改写', async () => {
    assert.equal(fs.existsSync(queueMarker), false); assert.equal(git('status', '--porcelain'), '');
    const calls = await worker.evaluate(() => globalThis.__projectE2ECalls); report.nativeCalls = calls;
    for (const op of ['project-info', 'project-bind', 'project-sync', 'project-read']) assert(calls.some(c => c.op === op), op);
    report.sourceUnchanged = Object.entries(report.sourceHashes).every(([name, value]) => hash(path.join(source, name)) === value);
    assert.equal(report.sourceUnchanged, true, '运行时主源有并发变更，请基于同一快照重跑');
    return {nativeCallCount: calls.length, sourceUnchanged: true, queueInvocations: 0};
  });
  report.status = 'passed';
}

run().catch(async error => {
  report.status = 'failed'; report.error = error.stack; console.error(error);
  if (page) await page.screenshot({path: path.join(output, 'failure.png')}).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (userManifest) {
      assert.equal(fs.readFileSync(userManifest, 'utf8'), manifestText, '只清理由本次写入且仍相同的独有 manifest');
      fs.unlinkSync(userManifest); report.userManifestRemoved = !fs.existsSync(userManifest);
    }
    report.queueInvocations = fs.existsSync(queueMarker) ? 1 : 0;
  } catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  record(); console.log(JSON.stringify({status: report.status, checks: report.checks.length, registration: report.registration, output, userManifestRemoved: report.userManifestRemoved}));
});
