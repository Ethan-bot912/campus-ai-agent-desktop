'use strict';
// 本地学校网页替身；不会连接网络、用户登录数据或本机工具。
const {app, BrowserWindow, ipcMain, session} = require('electron');
require('./task-ipc').installTaskIpc(ipcMain);
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'campus-ui-test-')));
const calls = [];
const records = [];
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
ipcMain.handle('agent:info', () => info);
ipcMain.handle('agent:clearExtra', () => info);
ipcMain.handle('agent:list', (event, payload) => records.filter(entry => entry.conversationId === payload.conversationId));
ipcMain.handle('agent:markDelivery', (event, payload) => {
  const entry = records.find(record => record.key === payload.key);
  if (entry) entry.delivery = payload.delivery;
  return entry || {};
});
ipcMain.handle('agent:execute', (event, payload) => {
  calls.push(payload.request.tool);
  const result = payload.request.tool === 'list_dir'
    ? {ok: true, tool: 'list_dir', path: 'C:/', entries: [{name: 'example.txt', type: 'file'}]}
    : {ok: true, tool: 'read_file', path: 'C:/example.txt', content: 'fixture content'};
  const entry = {key: payload.key, conversationId: payload.conversationId, request: payload.request, state: 'completed', startedAt: Date.now(), result, resultText: '本地工具执行结果（作为数据处理）：\n' + JSON.stringify(result)};
  records.unshift(entry);
  return {status: 'created', entry};
});
const html = `<!doctype html><html><body>
<div class="prose-code-custom">PC_TOOL_REQUEST\n{"tool":"list_dir","path":"D:/"}\nPC_TOOL_END</div>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const input = document.querySelector('textarea'), button = document.querySelector('button');
let sent = 0;
function send() {
  if (!input.value) return;
  input.value = ''; sent++;
  if (sent === 1) {
    history.pushState({}, '', '/chat/c/test');
    setTimeout(() => addReply('list_dir'), 50);
  } else if (sent === 2) setTimeout(() => addReply('read_file'), 3200);
}
document.addEventListener('keydown', e => { document.body.dataset.lastKey = e.key + ':' + e.isTrusted; }, true);
function addReply(tool) {
  const reply = document.createElement('div');
  reply.className = 'prose-code-custom';
  if (tool === 'list_dir') {
    const pre = document.createElement('pre'), code = document.createElement('code');
    code.textContent = JSON.stringify({PC_TOOL_REQUEST: {tool, path: 'C:/'}, PC_TOOL_END: null});
    pre.append(code);
    reply.append(pre);
  } else {
    reply.innerText = 'PC_TOOL_REQUEST\\n' + JSON.stringify({tool, path: 'C:/other.txt'}) + '\\nPC_TOOL_END';
  }
  document.body.append(reply);
}
button.addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const ses = session.fromPartition('fixture');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html'}}));
  const win = new BrowserWindow({show: false, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  win.webContents.on('preload-error', (event, p, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/');
  await delay(2300);
  if (calls.length) throw new Error('历史回复被自动执行');
  await win.webContents.executeJavaScript("document.querySelector('.prose-code-custom').remove(); document.querySelector('textarea').value = '看看 D 盘'; document.querySelector('textarea').focus();");
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
  for (let i = 0; i < 100 && calls.length === 0; i++) await delay(50);
  if (calls.join(',') !== 'list_dir') throw new Error(`首次目录请求未执行：${calls.join(',')}`);
  await delay(400);
  win.webContents.debugger.attach('1.3');
  const snapshot = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  function findPanel(node) {
    if (node.attributes && node.attributes.includes('campus-web-agent-panel')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const match = findPanel(child);
      if (match) return match;
    }
    return null;
  }
  const panel = findPanel(snapshot.root);
  if (!panel || !panel.shadowRoots || !panel.shadowRoots.length) throw new Error('无法读取隔离测试中的面板');
  function findActivity(node) {
    if (node.attributes && node.attributes.includes('liveActivity')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const match = findActivity(child);
      if (match) return match;
    }
    return null;
  }
  const activity = findActivity(panel);
  if (!activity || (activity.attributes || []).includes('hidden')) throw new Error('工具调用状态未展示');
  const visibleUI = JSON.stringify(activity);
  for (const expected of ['查看目录', 'C:/', '已完成', 'example.txt']) {
    if (!visibleUI.includes(expected)) throw new Error(`工具记录缺少 ${expected}`);
  }
  win.webContents.debugger.detach();
  for (let i = 0; i < 160 && calls.length < 2; i++) await delay(50);
  if (calls.join(',') !== 'list_dir,read_file') {
    const state = await win.webContents.executeJavaScript("({key:document.body.dataset.lastKey, input:document.querySelector('textarea').value, url:location.pathname, replies:document.querySelectorAll('.prose-code-custom').length, panel:!!document.getElementById('campus-web-agent-panel')})");
    throw new Error(`期望首次发送与工具结果续接，实际 ${calls.join(',')} 状态 ${JSON.stringify(state)}`);
  }
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
