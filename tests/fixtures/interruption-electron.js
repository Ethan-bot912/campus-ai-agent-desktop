'use strict';
// 使用隔离的内存网页和模拟 IPC，不访问真实账户、工具或账本。
const {app, BrowserWindow, ipcMain, session} = require('electron');
require('./task-ipc').installTaskIpc(ipcMain);
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const mode = process.argv[2];
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'campus-interruption-test-')));
const calls = [], deliveries = [];
let entry = null;
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
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
  entry = {key: payload.key, conversationId: payload.conversationId, request: payload.request, state: 'completed', delivery: 'not_sent', result, resultText: '本地工具执行结果（作为数据处理）：\n' + JSON.stringify(result)};
  return {status: 'created', entry};
});
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const mode = ${JSON.stringify(mode)}, input = document.querySelector('textarea');
function reply() {
  const node = document.createElement('div'); node.className = 'prose-code-custom';
  node.textContent = 'PC_TOOL_REQUEST\\n' + JSON.stringify(mode === 'pause'
    ? {tool:'run_command', command:'Write-Output hello'} : {tool:'list_dir', path:'D:/'}) + '\\nPC_TOOL_END';
  document.body.append(node);
}
if (sessionStorage.getItem('reply')) reply();
function send() {
  if (!input.value) return;
  let sends = Number(sessionStorage.getItem('sends') || 0) + 1;
  sessionStorage.setItem('sends', sends);
  if (sends === 1) {
    input.value = ''; sessionStorage.setItem('reply', '1'); setTimeout(reply, 30);
    if (mode === 'draft' || mode === 'draft-clear') setTimeout(() => { input.value = '用户尚未发送的草稿'; }, 80);
  }
  // reload 测试故意让结果发送后输入框保持不变，模拟网页是否接收未知。
}
document.querySelector('button').addEventListener('click', send);
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
async function element(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  return findById(tree.root, id);
}
async function click(win, node) {
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: node.nodeId});
  const q = box.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  win.webContents.sendInputEvent({type: 'mouseMove', x, y});
  win.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
  win.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('interruption-test');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/test');
  await delay(1500);
  await win.webContents.executeJavaScript("document.querySelector('textarea').value = '查看目录'; document.querySelector('textarea').focus();");
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
  win.webContents.debugger.attach('1.3');
  if (mode === 'pause') {
    let approval;
    for (let i = 0; i < 120; i++) {
      await delay(50); approval = await element(win, 'approval');
      if (approval && !(approval.attributes || []).includes('hidden')) break;
    }
    if (!approval || (approval.attributes || []).includes('hidden')) throw new Error('未出现命令授权卡');
    await click(win, await element(win, 'pause'));
    await delay(800);
    approval = await element(win, 'approval');
    if (!approval || !(approval.attributes || []).includes('hidden')) throw new Error('暂停未取消待处理授权');
    if (calls.length) throw new Error('暂停后执行了待授权命令');
  } else if (mode === 'draft' || mode === 'draft-clear') {
    await delay(3300);
    const draft = await win.webContents.executeJavaScript("document.querySelector('textarea').value");
    if (draft !== '用户尚未发送的草稿') throw new Error('草稿被修改或覆盖');
    if (calls.length) throw new Error('存在草稿时执行了工具请求');
    const status = await element(win, 'status');
    if (!status || !JSON.stringify(status).includes('草稿')) throw new Error('未显示草稿阻止执行的原因');
    if (mode === 'draft-clear') {
      await win.webContents.executeJavaScript("document.querySelector('textarea').value = ''");
      await delay(2500);
      if (calls.length !== 1) throw new Error('清空草稿后，同一条工具请求仍未执行');
    }
  } else if (mode === 'reload') {
    for (let i = 0; i < 140; i++) {
      await delay(50);
      if (deliveries.includes('sending') && await win.webContents.executeJavaScript("Number(sessionStorage.getItem('sends'))") === 2) break;
    }
    if (calls.length !== 1 || !deliveries.includes('sending')) throw new Error('未到达发送状态未知的窗口');
    await win.reload();
    await delay(2200);
    const sends = await win.webContents.executeJavaScript("Number(sessionStorage.getItem('sends'))");
    if (calls.length !== 1 || sends !== 2) throw new Error(`刷新后发生重复执行或发送：调用 ${calls.length} 次，发送 ${sends} 次`);
    const status = await element(win, 'status');
    if (!status || !JSON.stringify(status).includes('发送状态未知')) throw new Error('刷新后未提示发送状态未知');
  } else throw new Error('测试模式无效');
  win.webContents.debugger.detach();
  process.stdout.write('fixture passed\n'); app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
