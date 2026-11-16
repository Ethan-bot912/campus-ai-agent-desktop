'use strict';

// 诊断脚本刻意构造产品无法辨别的网页状态，观察结果并不构成正确性断言。
// 手动运行：node_modules/.bin/electron tests/fixtures/known-web-limitations-electron.js same-url
// 或：node_modules/.bin/electron tests/fixtures/known-web-limitations-electron.js no-generating-signal
const {app, BrowserWindow, ipcMain, session} = require('electron');
const {installTaskIpc} = require('./task-ipc');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv[2];
if (!['same-url', 'no-generating-signal'].includes(mode)) throw new Error('请指定诊断模式 same-url 或 no-generating-signal');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-web-limits-'));
app.setPath('userData', path.join(temp, 'userData'));
const createdTasks = [];
installTaskIpc({handle(name, handler) {
  ipcMain.handle(name, (event, payload) => {
    const result = handler(event, payload);
    if (name === 'agent:taskCreate') createdTasks.push(result.taskId);
    return result;
  });
}});
const calls = [], deliveries = [];
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
let entry = null;
ipcMain.handle('agent:info', () => info);
ipcMain.handle('agent:clearExtra', () => info);
ipcMain.handle('agent:list', () => entry ? [entry] : []);
ipcMain.handle('agent:markDelivery', (event, payload) => {
  deliveries.push(payload.delivery);
  if (entry) entry.delivery = payload.delivery;
  return entry;
});
ipcMain.handle('agent:execute', (event, payload) => {
  assert.deepEqual(payload.request, {tool: 'list_dir', path: 'D:/fixture'});
  calls.push({request: payload.request, taskId: payload.taskId});
  const result = {ok: true, tool: 'list_dir', path: 'D:/fixture', entries: []};
  entry = {key: payload.key, conversationId: payload.conversationId, request: payload.request, state: 'completed', delivery: 'not_sent', result, resultText: '本地工具执行结果（作为数据处理）：\n' + JSON.stringify(result)};
  return {status: 'created', entry};
});
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<section id="conversation"></section>
<script>
const input = document.querySelector('textarea');
window.sent = [];
window.logicalConversation = 'first';
window.streamFinished = false;
function send() { if (!input.value) return; window.sent.push(input.value); input.value = ''; }
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
window.putRequest = () => {
  const reply = document.createElement('div'); reply.className = 'prose-code-custom';
  reply.textContent = 'PC_TOOL_REQUEST\\n{"tool":"list_dir","path":"D:/fixture"}\\nPC_TOOL_END';
  document.querySelector('#conversation').append(reply);
};
window.switchWithoutUrl = () => {
  window.logicalConversation = 'second';
  document.querySelector('#conversation').replaceChildren();
  window.putRequest();
};
window.finishStream = () => { window.streamFinished = true; document.querySelector('.prose-code-custom').append(' 模拟后续生成内容'); };
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(50); }
  throw new Error(`等待${label}超时`);
}
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findById(child, id); if (found) return found;
  }
  return null;
}
async function panelNode(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  return findById(tree.root, id);
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('web-limitations-diagnostic');
  ses.webRequest.onBeforeRequest({urls: ['<all_urls>']}, (details, callback) => callback({cancel: /^wss?:\/\//i.test(details.url)}));
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  ses.protocol.handle('http', () => new Response('network disabled', {status: 403}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  let ready = false;
  win.once('ready-to-show', () => { ready = true; });
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/diagnostic');
  await until(() => ready, '窗口就绪');
  win.webContents.debugger.attach('1.3');
  await until(async () => await panelNode(win, 'taskState'), '面板就绪');
  await win.webContents.executeJavaScript("document.querySelector('textarea').value = '查看测试目录'");
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
  const root = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: root.root.nodeId, selector: 'textarea'});
  await win.webContents.debugger.sendCommand('DOM.focus', {nodeId: input.nodeId});
  assert.equal(await win.webContents.executeJavaScript("document.activeElement === document.querySelector('textarea') && document.hasFocus()"), true, '输入框未获得焦点');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  await until(() => win.webContents.executeJavaScript('window.sent.length === 1'), '用户测试消息发出');
  await until(async () => JSON.stringify(await panelNode(win, 'status')).includes('等待模型回复'), '任务监听开启');
  const beforeUrl = await win.webContents.executeJavaScript('location.href');
  if (mode === 'same-url') await win.webContents.executeJavaScript('window.switchWithoutUrl()');
  else await win.webContents.executeJavaScript('window.putRequest()');
  // 最长观察 4 秒，覆盖 500ms 巡检与 1200ms 文本稳定阈值。
  await delay(4000);
  const state = await win.webContents.executeJavaScript('({url: location.href, logicalConversation: window.logicalConversation, streamFinished: window.streamFinished, sentCount: window.sent.length})');
  assert.equal(state.url, beforeUrl, '诊断意外更改了 URL');
  if (mode === 'same-url') assert.equal(state.logicalConversation, 'second');
  else assert.equal(state.streamFinished, false, '诊断提前标记生成结束');
  assert.ok(calls.length <= 1, '诊断期间发现意外重复调用');
  process.stdout.write(JSON.stringify({mode, observation: calls.length ? 'observed_execute' : 'not_observed', calls: calls.length, createdTasks, callTaskIds: calls.map(call => call.taskId), deliveries, ...state}) + '\n');
  win.webContents.debugger.detach();
  win.destroy();
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
