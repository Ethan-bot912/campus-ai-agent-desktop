'use strict';
// 学校网页及工具均为内存替身，任务和流水只写入全新临时目录。
const {app, BrowserWindow, ipcMain, session} = require('electron');
const {TaskStore} = require('../../task-store');
const {Ledger} = require('../../ledger');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const mode = process.argv[2];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-task-workbench-'));
app.setPath('userData', path.join(temp, 'userData'));
let store, ledger;
const events = [], calls = [];
let releaseExecution, releasePreStart, releaseCreation, releaseRecover, releaseClear, releaseRecords, denied = false, recoverCalls = 0, clearCalls = 0, resultAttempts = 0;
const actualHandlers = new Map(), actualListeners = new Map();
class IsolatedTaskStore extends TaskStore {
  constructor({runId}) { super({dir: path.join(temp, 'tasks'), runId}); store = this; }
  async create(payload) {
    if (['creation-pause', 'creation-switch'].includes(mode) && !releaseCreation) {
      await new Promise(resolve => { releaseCreation = resolve; });
    }
    return super.create(payload);
  }
  async recordStep(payload) {
    if (mode === 'step-save-failed' && payload.step.state === 'completed') throw new Error('模拟最终步骤记录失败');
    if (['before-execute', 'before-execute-switch'].includes(mode) && payload.step.state === 'requested' && !releasePreStart) {
      await new Promise(resolve => { releasePreStart = resolve; });
    }
    return super.recordStep(payload);
  }
}
class IsolatedLedger extends Ledger {
  constructor({runId}) { super({dir: path.join(temp, 'ledger'), runId}); ledger = this; }
  async markDelivery(payload) {
    if (mode === 'delivery-mark-failed' && payload.delivery === 'unknown') throw new Error('模拟发送未知状态落盘失败');
    if (mode === 'delivery-submitted-failed' && payload.delivery === 'submitted') throw new Error('模拟发送成功状态落盘失败');
    return super.markDelivery(payload);
  }
  async recordResult(payload) {
    resultAttempts++;
    if (mode === 'ledger-fails-always' || (mode === 'ledger-fails-once' && resultAttempts === 1)) throw new Error('模拟工具结果落盘失败');
    return super.recordResult(payload);
  }
}
const fakeTools = {
  ...require('../../tools'),
  async executeTool(scope, request) {
    calls.push(request);
    if (['execute-switch', 'execute-end', 'reload'].includes(mode)) await new Promise(resolve => { releaseExecution = resolve; });
    return request.tool === 'list_dir'
      ? {ok: true, tool: request.tool, path: request.path, entries: [{name: 'sample.txt', type: 'file'}]}
      : {ok: true, tool: request.tool, path: request.path, content: 'fixture content'};
  }
};
const fakeElectron = {
  app: {setPath() {}, requestSingleInstanceLock: () => false, quit() {}, on() {}},
  ipcMain: {handle: (name, handler) => actualHandlers.set(name, handler), on: (name, handler) => actualListeners.set(name, handler)},
  BrowserWindow: {}, session: {}, shell: {}, dialog: {}
};
const project = path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(project, 'main.js'), 'utf8');
const fakeRequire = name => {
  if (name === 'electron') return fakeElectron;
  if (name === './tools') return fakeTools;
  if (name === './ledger') return {Ledger: IsolatedLedger};
  if (name === './task-store') return {TaskStore: IsolatedTaskStore};
  if (name.startsWith('./')) return require(path.join(project, name));
  return require(name);
};
// 加载生产主进程代码，但替换所有用户数据目录及桌面外壳，不启动真实窗口或本地工具。
vm.runInThisContext(`(function(require, __dirname, module, exports) {${mainSource}\n})`, {filename: 'main.js'})(fakeRequire, project, {exports: {}}, {});
for (const [name, handler] of actualHandlers) {
  ipcMain.handle(name, async (event, payload) => {
    if (name === 'agent:taskRecover') {
      recoverCalls++;
      if (mode === 'recover-race' && recoverCalls === 2) await new Promise(resolve => { releaseRecover = resolve; });
    }
    if (name === 'agent:clearExtra' && mode === 'end-race' && ++clearCalls === 1) await new Promise(resolve => { releaseClear = resolve; });
    if (name === 'agent:taskRecords' && mode === 'deny-render-switch' && denied && !releaseRecords) await new Promise(resolve => { releaseRecords = resolve; });
    const result = await handler(event, payload);
    if (name === 'agent:deny' && mode === 'deny-render-switch') denied = true;
    if (name === 'agent:taskCreate') events.push({name: 'create', taskId: result.taskId});
    if (name === 'agent:taskStatus') events.push({name: 'status', taskId: result.taskId, status: payload.status});
    if (name === 'agent:taskAdopt') events.push({name: 'adopt', taskId: result.taskId, conversationId: result.conversationId});
    return result;
  });
}
for (const [name, handler] of actualListeners) ipcMain.on(name, handler);

const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const mode = ${JSON.stringify(mode)}, input = document.querySelector('textarea');
function send() {
  if (!input.value) return;
  if (['delivery-unknown', 'delivery-mark-failed', 'delivery-submitted-failed', 'scope-during-send'].includes(mode) && input.value.startsWith('本地工具执行结果')) {
    window.feedbackClicked = true;
    if (mode === 'delivery-submitted-failed') input.value = '';
    return;
  }
  input.value = '';
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
window.fixtureReply = text => { const node = document.createElement('div'); node.className = 'prose-code-custom'; node.textContent = text; document.body.append(node); };
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
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
async function click(win, node) {
  if (!node) throw new Error('未找到面板按钮');
  await win.webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', {nodeId: node.nodeId});
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: node.nodeId});
  const q = box.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  const hit = await win.webContents.debugger.sendCommand('DOM.getNodeForLocation', {x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true});
  if (hit.backendNodeId !== node.backendNodeId) {
    const hitNode = await win.webContents.debugger.sendCommand('DOM.describeNode', {backendNodeId: hit.backendNodeId});
    throw new Error(`面板按钮未命中：目标 ${JSON.stringify(node.attributes)}，实际 ${JSON.stringify(hitNode.node.attributes)}`);
  }
  win.webContents.sendInputEvent({type: 'mouseMove', x, y});
  win.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
  win.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
}
async function sendUser(win, message) {
  await win.webContents.executeJavaScript(`document.querySelector('textarea').value=${JSON.stringify(message)}`);
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: tree.root.nodeId, selector: 'textarea'});
  await win.webContents.debugger.sendCommand('DOM.focus', {nodeId: input.nodeId});
  if (!await win.webContents.executeJavaScript("document.activeElement === document.querySelector('textarea')")) throw new Error('测试输入框未获得焦点');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
}
async function reply(win, request) {
  const text = typeof request === 'string' ? request : `PC_TOOL_REQUEST\n${JSON.stringify(request)}\nPC_TOOL_END`;
  await win.webContents.executeJavaScript(`window.fixtureReply(${JSON.stringify(text)})`);
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('task-workbench-test');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL(mode === 'lifecycle' ? 'https://ai.cuhk.edu.cn/chat/' : 'https://ai.cuhk.edu.cn/chat/c/test');
  await delay(1400);
  win.webContents.debugger.attach('1.3');
  await sendUser(win, '请查看测试目录');
  if (mode === 'creation-pause' || mode === 'creation-switch') {
    await until(() => Boolean(releaseCreation), '创建任务落盘');
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    if (mode === 'creation-pause') await click(win, await panelNode(win, 'pause'));
    else await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
    await delay(500);
    releaseCreation();
    await delay(2400);
    if (calls.length) throw new Error('任务创建落盘期间暂停或切换后仍执行了旧请求');
    win.webContents.debugger.detach();
    process.stdout.write('fixture passed\n');
    app.exit(0);
    return;
  }
  await until(() => events.some(event => event.name === 'create'), '创建任务');
  const originalId = events.find(event => event.name === 'create').taskId;
  if (mode === 'lifecycle') {
    await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/test')");
    await until(() => events.some(event => event.name === 'adopt'), '新对话迁移');
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => calls.length === 1, '目录工具');
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'})).steps.some(step => step.tool === 'list_dir' && step.state === 'completed'), '目录记录');
    await until(async () => {
      const task = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
      const step = task.steps.find(item => item.tool === 'list_dir');
      return (await ledger.read(step.key))?.delivery === 'submitted';
    }, '目录结果回填');
    await reply(win, {tool: 'read_file', path: 'D:/fixture/sample.txt'});
    await until(() => calls.length === 2, '文件工具');
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'})).steps.some(step => step.tool === 'read_file' && step.state === 'completed'), '文件记录');
    await until(async () => {
      const task = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
      const step = task.steps.find(item => item.tool === 'read_file');
      return (await ledger.read(step.key))?.delivery === 'submitted';
    }, '文件结果回填');
    if (events.filter(event => event.name === 'create').length !== 1) throw new Error('连续工具未归入同一任务');
    await reply(win, '模型说任务已完成。');
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'})).status === 'waiting_verification', '模型报告待验证');
    const evidence = await panelNode(win, 'taskEvidence');
    if (!evidence || !JSON.stringify(evidence).includes('未验证')) throw new Error('模型宣称完成后面板未明确展示尚未验证');
    await sendUser(win, '补充：请确认一下');
    await delay(1000);
    if (events.filter(event => event.name === 'create').length !== 1) throw new Error('用户补充被误建成新任务');
    await click(win, await panelNode(win, 'newTask'));
    await sendUser(win, '这是另一个任务');
    await until(() => events.filter(event => event.name === 'create').length === 2, '第二个任务');
    const taskIds = events.filter(event => event.name === 'create').map(event => event.taskId);
    if (new Set(taskIds).size !== 2) throw new Error('新任务未产生独立 ID');
  } else if (['approval-switch', 'approval-pause', 'approval-deny', 'approval-cancel-history', 'deny-render-switch'].includes(mode)) {
    await reply(win, {tool: 'run_command', command: 'Write-Output test'});
    await until(async () => { const approval = await panelNode(win, 'approval'); return approval && !(approval.attributes || []).includes('hidden'); }, '授权卡');
    if (mode === 'approval-switch') await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
    else await click(win, await panelNode(win, ['approval-deny', 'deny-render-switch'].includes(mode) ? 'deny' : mode === 'approval-cancel-history' ? 'newTask' : 'pause'));
    if (mode === 'deny-render-switch') {
      await until(() => Boolean(releaseRecords), '拒绝结果渲染');
      await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
      await delay(800);
      releaseRecords();
      await delay(1000);
      await sendUser(win, '新对话的新任务');
      await until(() => events.filter(event => event.name === 'create').length === 2, '新对话创建任务');
      const secondId = events.filter(event => event.name === 'create')[1].taskId;
      const newTask = await store.get({taskId: secondId, conversationId: '/chat/c/other'});
      if (!newTask || newTask.status === 'paused' || newTask.status === 'unknown') throw new Error('旧拒绝流程污染了新任务');
      if (calls.length) throw new Error('拒绝或切换后执行了旧命令');
      win.webContents.debugger.detach(); process.stdout.write('fixture passed\n'); app.exit(0); return;
    }
    await delay(1800);
    const approval = await panelNode(win, 'approval');
    if (!approval || !(approval.attributes || []).includes('hidden') || calls.length) throw new Error('切换对话或暂停后旧授权仍存在或命令被执行');
    if (mode === 'approval-deny') {
      await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
      await delay(2400);
      if (calls.length) throw new Error('拒绝授权后仍执行后续工具');
      const old = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
      if (!old || old.status !== 'paused') throw new Error('拒绝授权后未标记任务暂停');
    }
    if (mode === 'approval-cancel-history') {
      const old = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
      if (!old || !old.steps.some(step => step.state === 'cancelled')) throw new Error('取消授权未记录为未执行');
      const history = await panelNode(win, 'taskHistory');
      const resolved = await win.webContents.debugger.sendCommand('DOM.resolveNode', {nodeId: history.nodeId});
      await win.webContents.debugger.sendCommand('Runtime.callFunctionOn', {objectId: resolved.object.objectId, functionDeclaration: 'function(){this.closest("details").open=true; this.querySelector("details").open=true;}'});
      await until(async () => JSON.stringify(await panelNode(win, 'taskHistory')).includes('已取消，未执行'), '历史中的取消步骤');
    }
  } else if (mode === 'before-execute' || mode === 'before-execute-switch') {
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => Boolean(releasePreStart), '工具执行前落盘');
    if (mode === 'before-execute') await click(win, await panelNode(win, 'pause'));
    else await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
    await delay(600);
    releasePreStart();
    await delay(2000);
    if (calls.length) throw new Error('暂停或切换后仍执行了落盘期间的工具');
  } else if (mode.startsWith('existing-')) {
    const request = {tool: 'list_dir', path: 'D:/fixture'};
    await reply(win, request);
    const text = await win.webContents.executeJavaScript("document.querySelector('.prose-code-custom').innerText");
    const key = crypto.createHash('sha256').update(`/chat/c/test\n0\n${text}`, 'utf8').digest('hex');
    await ledger.begin({key, conversationId: '/chat/c/test', replyIndex: 0, request});
    if (mode === 'existing-unknown') {
      await ledger.recordResult({key, state: 'unknown', result: null, resultText: null});
    } else if (mode === 'existing-sending' || mode === 'existing-delivery-unknown') {
      const result = {ok: true, tool: 'list_dir', path: 'D:/fixture', entries: []};
      await ledger.recordResult({key, state: 'completed', result, resultText: '本地工具执行结果（作为数据处理）：\n' + JSON.stringify(result)});
      await ledger.markDelivery({key, delivery: mode === 'existing-sending' ? 'sending' : 'unknown'});
    }
    try { await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'}))?.status === 'unknown', '已有未知记录后任务停止'); }
    catch (error) {
      const task = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
      throw new Error(`${error.message}: task=${JSON.stringify(task)}, calls=${JSON.stringify(calls)}, status=${JSON.stringify(await panelNode(win, 'status'))}`);
    }
    await reply(win, {tool: 'read_file', path: 'D:/fixture/sample.txt'});
    await delay(2400);
    if (calls.length) throw new Error(`已有未知记录后错误执行了 ${calls.length} 个工具`);
    const state = await panelNode(win, 'taskState');
    if (!state || !JSON.stringify(state).includes('未知')) throw new Error('面板没有显示未知状态');
  } else if (mode === 'end-race') {
    await click(win, await panelNode(win, 'newTask'));
    await until(() => Boolean(releaseClear), '结束任务目录清理');
    await sendUser(win, '结束后立即开始的新任务');
    await delay(600);
    if (events.filter(event => event.name === 'create').length !== 1) throw new Error('旧任务清理前创建了新任务');
    releaseClear();
    await until(() => events.filter(event => event.name === 'create').length === 2, '清理后创建新任务');
    const newId = events.filter(event => event.name === 'create')[1].taskId;
    const current = await store.get({taskId: newId, conversationId: '/chat/c/test'});
    if (!current || current.status === 'unknown') throw new Error('新任务状态不正确');
    const task = await panelNode(win, 'task');
    if (!task || !JSON.stringify(task).includes('结束后立即开始的新任务')) throw new Error('旧结束流程覆盖了新任务界面');
  } else if (mode === 'ledger-fails-once' || mode === 'ledger-fails-always') {
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => calls.length === 1, '只读工具实际执行');
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'}))?.status === 'unknown', '结果落盘失败后任务未知');
    await delay(2200);
    if (calls.length !== 1) throw new Error('结果记录失败后工具被重复执行');
    const task = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
    const entry = await ledger.read(task.steps[0].key);
    if (entry && (entry.state === 'failed' || entry.resultText)) throw new Error('把记录失败伪报为工具失败或提供了虚假回填');
    if (await win.webContents.executeJavaScript('Boolean(window.feedbackClicked)')) throw new Error('结果落盘失败后仍向模型发送结果');
    const status = await panelNode(win, 'status');
    if (!status || !JSON.stringify(status).includes('可能已执行')) throw new Error('未提示工具可能已经执行');
  } else if (mode === 'step-save-failed') {
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => calls.length === 1, '只读工具实际执行');
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'}))?.status === 'unknown', '记录失败后任务未知');
    await delay(2000);
    const task = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
    const entry = await ledger.read(task.steps[0].key);
    const status = await panelNode(win, 'status');
    const taskState = await panelNode(win, 'taskState');
    if (!entry || entry.state !== 'completed' || calls.length !== 1) throw new Error('实际完成的工具未保留或被重复执行');
    if (!taskState || !JSON.stringify(taskState).includes('状态未知') || !status || !JSON.stringify(status).includes('可能已执行') || JSON.stringify(status).includes('未执行')) throw new Error('结果记录失败时状态不准确');
  } else if (['delivery-unknown', 'delivery-mark-failed', 'delivery-submitted-failed', 'scope-during-send'].includes(mode)) {
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => calls.length === 1, '第一个只读工具');
    await until(async () => Boolean(await win.webContents.executeJavaScript('window.feedbackClicked')), '触发结果发送');
    if (mode === 'scope-during-send') {
      await click(win, await panelNode(win, 'settingsToggle'));
      await click(win, await panelNode(win, 'clearWorkspace'));
    }
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'}))?.status === 'unknown', '发送未知后任务停止');
    await win.webContents.executeJavaScript("document.querySelector('textarea').value=''");
    await reply(win, {tool: 'read_file', path: 'D:/fixture/sample.txt'});
    await delay(2500);
    if (calls.length !== 1) throw new Error('发送状态未知后仍执行了后续请求');
    const status = await panelNode(win, 'status');
    if (!status || !JSON.stringify(status).includes('未知')) throw new Error('面板未提示发送状态未知');
    if (mode === 'delivery-mark-failed' && /工具执行失败|未执行/.test(JSON.stringify(status))) throw new Error('发送状态落盘失败被虚假描述为工具失败或未执行');
    await click(win, await panelNode(win, 'pause'));
    await sendUser(win, '尝试继续旧任务');
    await reply(win, {tool: 'read_file', path: 'D:/fixture/sample.txt'});
    await delay(2300);
    if (calls.length !== 1 || events.filter(event => event.name === 'create').length !== 1) throw new Error('未知任务恢复或用户发送后错误继续执行');
    await click(win, await panelNode(win, 'newTask'));
    await sendUser(win, '新任务');
    try { await until(() => events.filter(event => event.name === 'create').length === 2, '创建新任务'); }
    catch (error) {
      const state = await panelNode(win, 'taskState');
      const statusAfter = await panelNode(win, 'status');
      const button = await panelNode(win, 'newTask');
      const inputState = await win.webContents.executeJavaScript("({value: document.querySelector('textarea').value, active: document.activeElement?.tagName, focused: document.hasFocus()})");
      throw new Error(`${error.message}: taskState=${JSON.stringify(state)}, status=${JSON.stringify(statusAfter)}, button=${JSON.stringify(button)}, input=${JSON.stringify(inputState)}, events=${JSON.stringify(events)}`);
    }
    const newId = events.filter(event => event.name === 'create')[1].taskId;
    const newTask = await store.get({taskId: newId, conversationId: '/chat/c/test'});
    if (!newTask || newTask.status === 'unknown') throw new Error('旧任务发送未知错误影响了新任务');
  } else if (mode === 'reload') {
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => Boolean(releaseExecution), '刷新前工具开始');
    await win.reload();
    await until(async () => (await store.get({taskId: originalId, conversationId: '/chat/c/test'}))?.status === 'unknown', '刷新后任务状态未知');
    releaseExecution();
    await delay(2000);
    const old = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
    if (calls.length !== 1 || old.status !== 'unknown') throw new Error(`刷新后发生重跑或状态错误: calls=${calls.length}, status=${old.status}`);
  } else if (mode === 'recover-race') {
    await win.reload();
    await until(() => Boolean(releaseRecover), '刷新后的任务恢复');
    await sendUser(win, '刷新后新任务');
    await delay(600);
    if (events.filter(event => event.name === 'create').length !== 1) throw new Error('旧任务恢复未结束，新任务就已创建');
    releaseRecover();
    await until(() => events.filter(event => event.name === 'create').length === 2, '恢复结束后创建新任务');
    const newId = events.filter(event => event.name === 'create')[1].taskId;
    await delay(800);
    const old = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
    const current = await store.get({taskId: newId, conversationId: '/chat/c/test'});
    if (old.status !== 'unknown' || !current || current.status === 'unknown') throw new Error(`恢复错误归属状态: old=${old.status}, new=${current?.status}`);
  } else if (mode === 'execute-switch' || mode === 'execute-end') {
    await reply(win, {tool: 'list_dir', path: 'D:/fixture'});
    await until(() => Boolean(releaseExecution), '模拟工具开始');
    if (mode === 'execute-switch') await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
    else await click(win, await panelNode(win, 'newTask'));
    await delay(900);
    if (mode === 'execute-end') {
      const ended = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
      if (!ended || ended.status !== 'unknown') throw new Error(`工具正在运行时结束不应标记完成，实际为 ${ended?.status}`);
    }
    releaseExecution();
    await delay(1800);
    const old = await store.get({taskId: originalId, conversationId: '/chat/c/test'});
    if (!old || !old.steps.some(step => step.state === 'completed')) throw new Error('执行结果未保存到原任务');
    if (mode === 'execute-end' && old.status !== 'unknown') throw new Error('旧操作返回后错误改变了未知状态');
    if (mode === 'execute-switch') {
      const current = await store.list({conversationId: '/chat/c/other'});
      if (current.some(task => task.steps.length)) throw new Error('旧工具步骤错误归入新对话');
    }
    const activity = await panelNode(win, 'liveActivity');
    if (activity && JSON.stringify(activity).includes('sample.txt')) throw new Error('旧执行结果污染了当前面板');
  } else throw new Error(`未知场景 ${mode}`);
  win.webContents.debugger.detach();
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
