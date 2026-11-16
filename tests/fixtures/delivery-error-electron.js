'use strict';
// 独立内存网页、模拟 IPC；不接触真实学校网站、工具或用户资料。
const {app, BrowserWindow, ipcMain, session} = require('electron');
require('./task-ipc').installTaskIpc(ipcMain);
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const mode = process.argv[2] || 'reject';
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'campus-delivery-test-')));
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
const calls = [], deliveries = [];
let entry = null;
ipcMain.handle('agent:info', () => info);
ipcMain.handle('agent:clearExtra', () => info);
ipcMain.handle('agent:list', () => entry ? [entry] : []);
ipcMain.handle('agent:markDelivery', (event, value) => {
  deliveries.push(value.delivery);
  if (entry) entry.delivery = value.delivery;
  return entry;
});
ipcMain.handle('agent:execute', (event, payload) => {
  calls.push(payload.request.tool);
  const result = {ok: true, tool: payload.request.tool, entries: []};
  entry = {key: payload.key, conversationId: payload.conversationId, request: payload.request, state: 'completed', result, resultText: '本地工具执行结果（作为数据处理）：\n' + JSON.stringify(result)};
  return {status: 'created', entry};
});
const html = `<!doctype html><html><body>
<div id="historical">Error Code: request.invalid</div>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const mode = ${JSON.stringify(mode)}, input = document.querySelector('textarea'), button = document.querySelector('button');
let sends = 0;
function reply() { const node = document.createElement('div'); node.className = 'prose-code-custom'; node.textContent = 'PC_TOOL_REQUEST\\n{"tool":"list_dir","path":"D:/"}\\nPC_TOOL_END'; document.body.append(node); }
function send() {
 if (!input.value) return;
 input.value = ''; sends++;
 if (sends === 1) setTimeout(reply, 30);
 if (sends === 2) {
   if (mode === 'switch') history.pushState({}, '', '/chat/c/other');
   if (mode !== 'baseline') setTimeout(() => { const node = document.createElement('div'); node.textContent = 'Error Code: request.invalid'; document.body.append(node); }, 450);
   setTimeout(reply, 1100);
 }
}
button.addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findById(child, id); if (found) return found;
  }
  return null;
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('delivery-test');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/test');
  await delay(1500);
  await win.webContents.executeJavaScript("document.querySelector('textarea').value = '查看目录'; document.querySelector('textarea').focus();");
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
  await delay(6000);
  if (mode === 'reject') {
    if (calls.length !== 1) throw new Error(`错误出现后不应执行后续操作，实际 ${calls.length} 次`);
    if (deliveries[deliveries.length - 1] !== 'unknown') throw new Error(`拒绝后状态应为 unknown，实际 ${deliveries.join(',')}`);
    win.webContents.debugger.attach('1.3');
    const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
    const status = findById(tree.root, 'status');
    if (!status || !JSON.stringify(status).includes('学校服务拒绝了工具结果消息')) throw new Error('用户不可见服务拒绝提示');
    win.webContents.debugger.detach();
  } else if (mode === 'baseline') {
    if (calls.length < 2) throw new Error('历史错误不应阻止后续操作');
    if (deliveries.includes('unknown')) throw new Error('历史错误被误认为本次拒绝');
  } else if (mode === 'switch') {
    if (calls.length !== 1) throw new Error('切换对话后不应执行旧任务的后续请求');
    if (!deliveries.includes('unknown')) throw new Error('发送过程中切换对话应标记发送状态未知');
    win.webContents.debugger.attach('1.3');
    const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
    const status = findById(tree.root, 'status');
    if (status && JSON.stringify(status).includes('学校服务拒绝了工具结果消息')) throw new Error('切换对话后的错误不应归到原结果');
    win.webContents.debugger.detach();
  } else throw new Error('测试模式无效');
  process.stdout.write('fixture passed\n'); app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
