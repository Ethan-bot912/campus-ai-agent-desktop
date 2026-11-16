'use strict';
// 内存网页与 mock IPC；不访问学校服务、个人登录资料或实际文件工具。
const {app, BrowserWindow, ipcMain, session} = require('electron');
require('./task-ipc').installTaskIpc(ipcMain);
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'campus-approval-test-')));
const calls = [];
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
ipcMain.handle('agent:info', () => info);
ipcMain.handle('agent:clearExtra', () => info);
ipcMain.handle('agent:list', () => []);
ipcMain.handle('agent:markDelivery', () => ({}));
ipcMain.handle('agent:execute', (event, payload) => {
  calls.push(payload.request);
  return {status: 'created', entry: {key: payload.key, conversationId: payload.conversationId, request: payload.request, state: 'completed', result: {ok: true}, resultText: null}};
});
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const input = document.querySelector('textarea');
input.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); input.value = '';
  const reply = document.createElement('div'); reply.className = 'prose-code-custom';
  reply.innerText = 'PC_TOOL_REQUEST\\n' + JSON.stringify({tool: 'run_command', command: 'Write-Output hello'}) + '\\nPC_TOOL_END';
  document.body.append(reply);
});
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const result = findById(child, id);
    if (result) return result;
  }
  return null;
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('fixture-no-workspace');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/test');
  await delay(1800);
  await win.webContents.executeJavaScript("document.querySelector('textarea').value = '输出 hello'; document.querySelector('textarea').focus();");
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
  win.webContents.debugger.attach('1.3');
  let button;
  for (let i = 0; i < 120; i++) {
    await delay(50);
    const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
    const approval = findById(tree.root, 'approval');
    if (approval && !(approval.attributes || []).includes('hidden')) {
      button = findById(approval, 'allowOnce');
      break;
    }
  }
  if (!button) throw new Error('未选择工作区时没有出现命令授权卡');
  if (calls.length) throw new Error('用户确认前执行了命令');
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: button.nodeId});
  const q = box.model.content;
  const x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  win.webContents.sendInputEvent({type: 'mouseMove', x, y});
  win.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
  win.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
  for (let i = 0; i < 80 && calls.length === 0; i++) await delay(50);
  if (calls.length !== 1 || calls[0].tool !== 'run_command') throw new Error(`确认后未执行预期命令：${calls.length}`);
  win.webContents.debugger.detach();
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
