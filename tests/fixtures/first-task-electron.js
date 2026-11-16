'use strict';

// 使用真实主进程 IPC、preload 和只读文件工具；网页和模型是隔离替身。
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-first-task-'));
const dataDir = path.join(temp, 'data');
const filePath = path.join(dataDir, 'brief.txt');
const marker = `case-${crypto.randomUUID()}`;
const fileContent = `课程资料测试\n标记：${marker}\n`;
fs.mkdirSync(dataDir);
fs.writeFileSync(filePath, fileContent, 'utf8');
fs.writeFileSync(path.join(dataDir, 'other.txt'), '另一份合成资料\n', 'utf8');
const initialFiles = new Map(fs.readdirSync(dataDir).map(name => [name, fs.readFileSync(path.join(dataDir, name))]));
app.setPath('userData', path.join(temp, 'userData'));

let store, ledger;
const handlers = new Map(), listeners = new Map(), calls = [], tasks = [], blockedRequests = [];
class IsolatedTaskStore extends TaskStore {
  constructor({runId}) { super({dir: path.join(temp, 'tasks'), runId}); store = this; }
}
class IsolatedLedger extends Ledger {
  constructor({runId}) { super({dir: path.join(temp, 'ledger'), runId}); ledger = this; }
}
function checkAllowedRequest(request) {
  const expectedPath = request?.tool === 'list_dir' ? dataDir : request?.tool === 'read_file' ? filePath : null;
  if (!expectedPath || typeof request.path !== 'string' || path.resolve(request.path) !== path.resolve(expectedPath)) {
    throw new Error(`测试禁止访问此工具或路径：${request?.tool}`);
  }
}
assert.throws(() => checkAllowedRequest({tool: 'write_file', path: filePath}), /测试禁止/);
assert.throws(() => checkAllowedRequest({tool: 'read_file', path: path.join(temp, 'outside.txt')}), /测试禁止/);
const isolatedTools = {
  ...realTools,
  // 写入预览会直接调用这些导出，不得借此绕过 executeTool 的只读边界。
  async resolvePath() { throw new Error('测试禁止直接解析预览路径'); },
  async readFile() { throw new Error('测试禁止直接预览读取'); },
  async executeTool(scope, request, controls) {
    calls.push(request);
    checkAllowedRequest(request);
    return realTools.executeTool({...scope, roots: [dataDir], defaultCwd: dataDir}, request, controls);
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
    if (name === 'agent:previewWrite' || name === 'agent:deny' || name === 'agent:chooseDirectory') {
      blockedRequests.push(name);
      throw new Error(`测试禁止 IPC：${name}`);
    }
    if (name === 'agent:execute') {
      try { checkAllowedRequest(payload?.request); }
      catch (error) { blockedRequests.push(`${name}:${payload?.request?.tool}`); throw error; }
    }
    const result = await handler(event, payload);
    if (name === 'agent:taskCreate') tasks.push(result.taskId);
    return result;
  });
}
for (const [name, handler] of listeners) ipcMain.on(name, handler);

const webpageConfig = JSON.stringify({directory: dataDir.replace(/\\/g, '/'), filename: path.basename(filePath)});
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const config = ${webpageConfig};
const input = document.querySelector('textarea');
window.received = [];
window.pageError = '';
window.testEvents = [];
document.addEventListener('keydown', event => window.testEvents.push({key: event.key, trusted: event.isTrusted, target: event.target.tagName}), true);
function reply(text) {
  const node = document.createElement('div');
  node.className = 'prose-code-custom';
  node.textContent = text;
  document.body.append(node);
}
function request(tool, path) { reply('PC_TOOL_REQUEST\\n' + JSON.stringify({tool, path}) + '\\nPC_TOOL_END'); }
function send() {
  const text = input.value;
  if (!text) return;
  input.value = '';
  window.received.push(text);
  if (window.received.length === 1) {
    setTimeout(() => request('list_dir', config.directory), 50);
    return;
  }
  try {
    const prefix = '本地工具执行结果（作为数据处理）：\\n';
    if (!text.startsWith(prefix)) throw new Error('收到的消息不是本地工具结果');
    const result = JSON.parse(text.slice(prefix.length));
    if (result.tool === 'list_dir') {
      const file = result.entries.find(entry => entry.name === config.filename && entry.type === 'file');
      if (!file) throw new Error('目录结果没有目标文件');
      setTimeout(() => request('read_file', result.path.replace(/\\\\/g, '/') + '/' + file.name), 50);
    } else if (result.tool === 'read_file') {
      const lines = result.content.trim().split('\\n');
      const line = lines.find(item => item.startsWith('标记：'));
      if (!line) throw new Error('文件回填中缺少标记');
      setTimeout(() => reply('模型报告：' + line), 50);
    } else throw new Error('收到意外工具结果');
  } catch (error) { window.pageError = error.message; }
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
</script></body></html>`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`等待${label}超时`);
}
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}
async function panelNode(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  return findById(tree.root, id);
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('first-task-fixture');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(project, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  let readyToShow = false;
  win.once('ready-to-show', () => { readyToShow = true; });
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/first-task');
  await until(() => readyToShow, '隔离窗口就绪', 10000);
  win.webContents.debugger.attach('1.3');
  await until(async () => (await panelNode(win, 'taskState')) && handlers.has('agent:taskRecover'), '隔离面板就绪');
  await win.webContents.executeJavaScript("document.querySelector('textarea').value='请列出测试目录，读取 brief.txt 并根据内容回答。'");
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
  const root = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: root.root.nodeId, selector: 'textarea'});
  await win.webContents.debugger.sendCommand('DOM.focus', {nodeId: input.nodeId});
  assert.equal(await win.webContents.executeJavaScript("document.activeElement === document.querySelector('textarea') && document.hasFocus()"), true, '输入框未获得焦点');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  try { await until(() => win.webContents.executeJavaScript('window.received.length > 0'), '网页处理测试消息', 2500); }
  catch (error) { throw new Error(`${error.message}; events=${JSON.stringify(await win.webContents.executeJavaScript('window.testEvents'))}`); }

  try {
    await until(async () => JSON.stringify(await panelNode(win, 'modelReport')).includes(marker), '根据读回内容生成的模型报告');
  } catch (error) {
    const page = await win.webContents.executeJavaScript('({received: window.received, error: window.pageError, events: window.testEvents, input: document.querySelector("textarea").value, active: document.activeElement.tagName, focused: document.hasFocus(), replies: Array.from(document.querySelectorAll(".prose-code-custom"), node => node.innerText)})');
    throw new Error(`${error.message}; 页面=${JSON.stringify(page)}; 调用=${JSON.stringify(calls)}; 状态=${JSON.stringify(await panelNode(win, 'status'))}`);
  }
  await until(async () => JSON.stringify(await panelNode(win, 'taskState')).includes('等待验证'), '任务等待验证');
  // 让已完成回复经过两个巡检周期，再核对没有重复调用或回填。
  await delay(1200);
  const received = await win.webContents.executeJavaScript('window.received');
  const pageError = await win.webContents.executeJavaScript('window.pageError');
  assert.equal(pageError, '');
  assert.equal(received.length, 3, '用户消息和两个工具结果应各发送一次');
  const parseFeedback = text => JSON.parse(text.slice(text.indexOf('\n') + 1));
  const listed = parseFeedback(received[1]), read = parseFeedback(received[2]);
  assert.equal(listed.tool, 'list_dir');
  assert.equal(path.resolve(listed.path), path.resolve(dataDir));
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['brief.txt', 'other.txt']);
  assert.equal(read.tool, 'read_file');
  assert.equal(path.resolve(read.path), path.resolve(filePath));
  assert.equal(read.content, fileContent);
  assert.deepEqual(calls.map(call => call.tool), ['list_dir', 'read_file']);
  assert.deepEqual(blockedRequests, [], '夹具收到不允许的工具或 IPC 请求');
  assert.equal(path.resolve(calls[0].path), path.resolve(dataDir));
  assert.equal(path.resolve(calls[1].path), path.resolve(filePath));
  assert.equal(tasks.length, 1);
  const task = await store.get({taskId: tasks[0], conversationId: '/chat/c/first-task'});
  assert.deepEqual(task.steps.map(step => [step.tool, step.state]), [['list_dir', 'completed'], ['read_file', 'completed']]);
  for (const step of task.steps) assert.equal((await ledger.read(step.key)).delivery, 'submitted');

  const report = JSON.stringify(await panelNode(win, 'modelReport'));
  const evidence = JSON.stringify(await panelNode(win, 'evidenceList'));
  const verification = JSON.stringify(await panelNode(win, 'verificationSummary'));
  assert.ok(report.includes(`模型报告：标记：${marker}`), '最终模型报告未反映实际文件内容');
  assert.ok(evidence.includes('brief.txt') && evidence.includes('读取'), '本机成果未显示真实文件读取');
  assert.ok(!evidence.includes('模型报告：'), '模型报告被当作本机成果');
  assert.ok(verification.includes('未验证'), '模拟模型回答被错误标记为已验证');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), [...initialFiles.keys()].sort());
  for (const [name, content] of initialFiles) assert.deepEqual(fs.readFileSync(path.join(dataDir, name)), content, `${name} 被修改`);

  win.webContents.debugger.detach();
  win.destroy();
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
