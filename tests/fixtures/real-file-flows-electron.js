'use strict';

// 真实主进程处理逻辑、preload 和临时文件工具；学校网页及模型由本地脚本替代。
const {app, BrowserWindow, ipcMain, session} = require('electron');
const {TaskStore} = require('../../task-store');
const {Ledger} = require('../../ledger');
const realTools = require('../../tools');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const mode = process.argv[2];
if (!['read-two', 'deny', 'create', 'overwrite'].includes(mode)) throw new Error('未知测试模式');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-real-files-'));
const dataDir = path.join(temp, 'data');
fs.mkdirSync(dataDir);
const fileA = path.join(dataDir, 'alpha.txt');
const fileB = path.join(dataDir, 'beta.txt');
const target = path.join(dataDir, 'result.txt');
const markerA = `alpha-${crypto.randomUUID()}`;
const markerB = `beta-${crypto.randomUUID()}`;
const oldContent = '共同开头\n覆盖前独特内容\n共同结尾\n';
const newContent = mode === 'overwrite'
  ? '共同开头\n覆盖后独特内容\n共同结尾\n'
  : `写入起点\n${'完整授权内容-'.repeat(400)}\n写入终点\n`;
if (mode === 'read-two') {
  fs.writeFileSync(fileA, `资料甲 ${markerA}\n`, 'utf8');
  fs.writeFileSync(fileB, `资料乙 ${markerB}\n`, 'utf8');
} else if (mode !== 'create') fs.writeFileSync(target, oldContent, 'utf8');
const initial = new Map(fs.readdirSync(dataDir).map(name => [name, fs.readFileSync(path.join(dataDir, name))]));
app.setPath('userData', path.join(temp, 'userData'));

let store, ledger;
const handlers = new Map(), listeners = new Map(), calls = [], blocked = [], tasks = [], previews = [];
class IsolatedTaskStore extends TaskStore {
  constructor({runId}) { super({dir: path.join(temp, 'tasks'), runId}); store = this; }
}
class IsolatedLedger extends Ledger {
  constructor({runId}) { super({dir: path.join(temp, 'ledger'), runId}); ledger = this; }
}
const tempScope = scope => ({...scope, root: null, roots: [dataDir], defaultCwd: dataDir});
function checkPath(actual, expected) {
  if (typeof actual !== 'string' || path.resolve(actual) !== path.resolve(expected)) throw new Error('夹具禁止此路径');
}
function checkRequest(request) {
  if (mode === 'read-two') {
    if (request?.tool === 'list_dir') return checkPath(request.path, dataDir);
    if (request?.tool === 'read_file' && [fileA, fileB].some(file => typeof request.path === 'string' && path.resolve(request.path) === path.resolve(file))) return;
  } else {
    if (request?.tool === 'read_file' || request?.tool === 'write_file') {
      checkPath(request.path, target);
      if (request.tool === 'write_file' && request.content !== newContent) throw new Error('夹具禁止非预期写入内容');
      return;
    }
  }
  throw new Error(`夹具禁止工具：${request?.tool}`);
}
assert.throws(() => checkRequest({tool: 'run_command', command: 'x'}), /夹具禁止/);
assert.throws(() => checkRequest({tool: 'read_file', path: path.join(temp, 'outside.txt')}), /夹具禁止/);
const isolatedTools = {
  ...realTools,
  async resolvePath(scope, value, options) { checkPath(value, target); return realTools.resolvePath(tempScope(scope), value, options); },
  async readFile(scope, value) { checkPath(value, target); return realTools.readFile(tempScope(scope), value); },
  async executeTool(scope, request, controls) {
    calls.push({...request});
    checkRequest(request);
    return realTools.executeTool(tempScope(scope), request, controls);
  }
};
const electronStub = {
  app: {setPath() {}, requestSingleInstanceLock: () => false, quit() {}, on() {}},
  ipcMain: {handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler)},
  BrowserWindow: {}, session: {}, shell: {}, dialog: {}
};
const project = path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(project, 'main.js'), 'utf8');
const isolatedRequire = name => {
  if (name === 'electron') return electronStub;
  if (name === './tools') return isolatedTools;
  if (name === './ledger') return {Ledger: IsolatedLedger};
  if (name === './task-store') return {TaskStore: IsolatedTaskStore};
  if (name.startsWith('./')) return require(path.join(project, name));
  return require(name);
};
vm.runInThisContext(`(function(require, __dirname, module, exports) {${mainSource}\n})`, {filename: 'main.js'})(isolatedRequire, project, {exports: {}}, {});
for (const [name, handler] of handlers) {
  ipcMain.handle(name, async (event, payload) => {
    try {
      if (name === 'agent:chooseDirectory' || name === 'agent:cancel') throw new Error(`夹具禁止 IPC：${name}`);
      if (name === 'agent:previewWrite') {
        checkRequest(payload);
        if (payload.tool !== 'write_file') throw new Error('夹具禁止非写入预览');
        previews.push({...payload});
      }
      if (name === 'agent:deny' || name === 'agent:execute') checkRequest(payload?.request);
    } catch (error) { blocked.push(`${name}: ${error.message}`); throw error; }
    const result = await handler(event, payload);
    if (name === 'agent:taskCreate') tasks.push(result.taskId);
    return result;
  });
}
for (const [name, handler] of listeners) ipcMain.on(name, handler);

const config = JSON.stringify({mode, directory: dataDir.replace(/\\/g, '/'), target: target.replace(/\\/g, '/'), newContent});
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const config = ${config}, input = document.querySelector('textarea');
window.received = []; window.pageError = '';
function reply(text) { const node = document.createElement('div'); node.className = 'prose-code-custom'; node.textContent = text; document.body.append(node); }
function request(value) { reply('PC_TOOL_REQUEST\\n' + JSON.stringify(value) + '\\nPC_TOOL_END'); }
window.fixtureRequest = request;
function send() {
  const text = input.value; if (!text) return; input.value = ''; window.received.push(text);
  if (window.received.length === 1) {
    setTimeout(() => request(config.mode === 'read-two' ? {tool:'list_dir', path:config.directory} : {tool:'write_file', path:config.target, content:config.newContent}), 50);
    return;
  }
  try {
    const prefix = '本地工具执行结果（作为数据处理）：\\n';
    if (!text.startsWith(prefix)) throw new Error('收到非工具结果');
    const result = JSON.parse(text.slice(prefix.length));
    if (!result.ok) throw new Error('模拟模型收到失败结果');
    if (result.tool === 'list_dir') {
      const names = ['alpha.txt', 'beta.txt'];
      if (!names.every(name => result.entries.some(entry => entry.name === name && entry.type === 'file'))) throw new Error('目录结果缺少文件');
      window.files = names.map(name => result.path.replace(/\\\\/g, '/') + '/' + name);
      window.contents = [];
      setTimeout(() => request({tool:'read_file', path:window.files[0]}), 50);
    } else if (result.tool === 'read_file' && config.mode === 'read-two') {
      window.contents.push(result.content.trim());
      if (window.contents.length === 1) setTimeout(() => request({tool:'read_file', path:window.files[1]}), 50);
      else setTimeout(() => reply('模型报告：' + window.contents.join(' / ')), 50);
    } else if (result.tool === 'write_file') {
      setTimeout(() => request({tool:'read_file', path:result.path.replace(/\\\\/g, '/')}), 50);
    } else if (result.tool === 'read_file') {
      setTimeout(() => reply('模型报告：已读回 ' + result.content.length + ' 字符'), 50);
    } else throw new Error('不符合预期的结果');
  } catch (error) { window.pageError = error.message; }
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
</script></body></html>`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`等待${label}超时`);
}
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = findById(child, id); if (found) return found; }
  return null;
}
function nodeText(node) { return (node?.nodeValue || '') + [...(node?.children || []), ...(node?.shadowRoots || [])].map(nodeText).join(''); }
async function panelNode(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  return findById(tree.root, id);
}
async function click(win, node) {
  if (!node) throw new Error('未找到面板按钮');
  await win.webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', {nodeId: node.nodeId});
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: node.nodeId});
  const q = box.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  const hit = await win.webContents.debugger.sendCommand('DOM.getNodeForLocation', {x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true});
  if (hit.backendNodeId !== node.backendNodeId) throw new Error('授权按钮未命中');
  win.webContents.sendInputEvent({type: 'mouseMove', x, y});
  win.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
  win.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
}
function assertFilesUnchanged() {
  assert.deepEqual(fs.readdirSync(dataDir).sort(), [...initial.keys()].sort());
  for (const [name, content] of initial) assert.deepEqual(fs.readFileSync(path.join(dataDir, name)), content, `${name} 被意外修改`);
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('real-file-flows');
  ses.webRequest.onBeforeRequest((details, callback) => callback({cancel: /^wss?:/i.test(details.url)}));
  for (const scheme of ['https', 'http']) ses.protocol.handle(scheme, () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(project, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  let ready = false;
  win.once('ready-to-show', () => { ready = true; });
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/real-files');
  await until(() => ready, '隔离窗口就绪', 10000);
  win.webContents.debugger.attach('1.3');
  await until(async () => (await panelNode(win, 'taskState')) && handlers.has('agent:taskRecover'), '面板就绪');
  await win.webContents.executeJavaScript("document.querySelector('textarea').value='请完成临时文件测试。'");
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
  const root = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: root.root.nodeId, selector: 'textarea'});
  await win.webContents.debugger.sendCommand('DOM.focus', {nodeId: input.nodeId});
  assert.equal(await win.webContents.executeJavaScript("document.activeElement === document.querySelector('textarea') && document.hasFocus()"), true, '输入框未聚焦');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
  await until(() => win.webContents.executeJavaScript('window.received.length === 1'), '用户消息');

  if (mode !== 'read-two') {
    await until(async () => { const node = await panelNode(win, 'approval'); return node && !(node.attributes || []).includes('hidden'); }, '写入授权卡');
    assertFilesUnchanged();
    assert.equal(calls.length, 0, '授权前已调用真实文件工具');
    assert.equal(previews.length, 1, '应预览一次待授权写入');
    const title = nodeText(await panelNode(win, 'approvalTitle'));
    const body = nodeText(await panelNode(win, 'approvalBody'));
    assert.ok(title.includes(target.replace(/\\/g, '/')), '授权标题没有完整目标');
    assert.ok(body.includes(target.replace(/\\/g, '/')) && body.includes(newContent), '授权卡缺少完整目标或新内容');
    if (mode === 'overwrite' || mode === 'deny') {
      assert.ok(body.includes('- 覆盖前独特内容') && body.includes('+ 覆盖后独特内容') === (mode === 'overwrite'), '覆盖前后差异不符合实际内容');
    } else assert.ok(body.includes('目标文件不存在，将新建'), '没有显示新建文件');
    await click(win, await panelNode(win, mode === 'deny' ? 'deny' : 'allowOnce'));
  }

  if (mode === 'deny') {
    await until(async () => nodeText(await panelNode(win, 'taskState')).includes('已暂停'), '拒绝后暂停');
    await win.webContents.executeJavaScript(`window.fixtureRequest(${JSON.stringify({tool: 'read_file', path: target.replace(/\\/g, '/')})})`);
    // 给 500ms 巡检与 1200ms 回复稳定窗口留出余量，观察错误继续执行。
    await delay(3000);
    assert.equal(calls.length, 0, '拒绝后执行了工具');
    assertFilesUnchanged();
    assert.equal((await win.webContents.executeJavaScript('window.received.length')), 1, '拒绝后错误回填');
    assert.ok(nodeText(await panelNode(win, 'status')).includes('暂停'));
    const task = await store.get({taskId: tasks[0], conversationId: '/chat/c/real-files'});
    assert.equal(task.status, 'paused');
    assert.deepEqual(task.steps.map(step => [step.tool, step.state]), [['write_file', 'denied']]);
  } else {
    const expectedText = mode === 'read-two' ? `模型报告：资料甲 ${markerA} / 资料乙 ${markerB}` : `模型报告：已读回 ${newContent.length} 字符`;
    try { await until(async () => nodeText(await panelNode(win, 'modelReport')).includes(expectedText), '模型替身基于回填生成报告'); }
    catch (error) {
      const page = await win.webContents.executeJavaScript('({received:window.received,error:window.pageError,replies:Array.from(document.querySelectorAll(".prose-code-custom"),node=>node.innerText)})');
      throw new Error(`${error.message}; page=${JSON.stringify(page)}; calls=${JSON.stringify(calls.map(call => call.tool))}; status=${nodeText(await panelNode(win, 'status'))}`);
    }
    await until(async () => nodeText(await panelNode(win, 'taskState')).includes('等待验证'), '任务等待验证');
    await delay(1200);
    assert.equal(await win.webContents.executeJavaScript('window.pageError'), '');
    const received = await win.webContents.executeJavaScript('window.received');
    const feedback = received.slice(1).map(text => JSON.parse(text.slice(text.indexOf('\n') + 1)));
    assert.deepEqual(calls.map(call => call.tool), mode === 'read-two' ? ['list_dir', 'read_file', 'read_file'] : ['write_file', 'read_file']);
    assert.deepEqual(feedback.map(result => result.tool), calls.map(call => call.tool));
    assert.equal(received.length, calls.length + 1, '出现重复发送');
    assert.equal(tasks.length, 1);
    const task = await store.get({taskId: tasks[0], conversationId: '/chat/c/real-files'});
    assert.deepEqual(task.steps.map(step => [step.tool, step.state]), calls.map(call => [call.tool, 'completed']));
    for (const step of task.steps) assert.equal((await ledger.read(step.key)).delivery, 'submitted');
    const evidence = nodeText(await panelNode(win, 'evidenceList'));
    assert.ok(!evidence.includes('模型报告：'), '模型报告混入本机成果');
    if (mode === 'read-two') {
      assertFilesUnchanged();
      assert.equal(feedback[1].content, `资料甲 ${markerA}\n`);
      assert.equal(feedback[2].content, `资料乙 ${markerB}\n`);
      assert.ok(evidence.includes('alpha.txt') && evidence.includes('beta.txt'));
    } else {
      assert.deepEqual(fs.readFileSync(target), Buffer.from(newContent, 'utf8'));
      assert.equal(calls[0].content, newContent);
      assert.equal(feedback[1].content, newContent);
      assert.ok(evidence.includes('写入') && evidence.includes('读取') && evidence.includes('result.txt'));
      assert.ok(evidence.includes('相同路径的写入与读取记录内容一致'), `写后读比较未显示一致：${evidence}`);
    }
  }
  assert.deepEqual(blocked, [], '夹具收到不允许的 IPC 或工具请求');
  win.webContents.debugger.detach();
  win.destroy();
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
