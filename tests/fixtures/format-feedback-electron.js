'use strict';
// 模拟学校网页与工具，仅向独立临时目录写测试记录。
const {app, BrowserWindow, ipcMain, session} = require('electron');
require('./task-ipc').installTaskIpc(ipcMain);
const {Ledger} = require('../../ledger');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const mode = process.argv[2];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-format-test-'));
app.setPath('userData', path.join(temp, 'userData'));
const ledger = new Ledger({dir: path.join(temp, 'ledger'), runId: 'fixture'});
const calls = [], feedbacks = [];
let markStarted = false, releaseMark, notSentStarted = false, releaseNotSent;
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
ipcMain.handle('agent:info', () => info);
ipcMain.handle('agent:clearExtra', () => info);
ipcMain.handle('agent:list', (event, payload) => ledger.list(payload.conversationId));
ipcMain.handle('agent:formatError', (event, payload) => ledger.recordFormatError(payload));
ipcMain.handle('agent:markDelivery', async (event, payload) => {
  if (payload.delivery === 'sending' && !markStarted && ['draft', 'switch', 'pause', 'pause-resume', 'generation', 'after-pause'].includes(mode)) {
    markStarted = true;
    await new Promise(resolve => { releaseMark = resolve; });
  }
  if (payload.delivery === 'not_sent' && mode === 'not-sent-switch') {
    notSentStarted = true;
    await new Promise(resolve => { releaseNotSent = resolve; });
  }
  return ledger.markDelivery(payload);
});
ipcMain.handle('agent:execute', async (event, payload) => {
  calls.push(payload.request);
  const begun = await ledger.begin(payload);
  if (begun.status === 'exists') return begun;
  const result = {ok: true, tool: payload.request.tool, entries: []};
  const entry = await ledger.recordResult({key: payload.key, state: 'completed', result, resultText: null});
  return {status: 'created', entry};
});
const invalid = 'PC_TOOL_REQUEST\n{"tool":"list_dir","path":"D:\\Documents"}\nPC_TOOL_END';
const valid = 'PC_TOOL_REQUEST\n{"tool":"list_dir","path":"D:/Documents"}\nPC_TOOL_END';
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const mode = ${JSON.stringify(mode)}, invalid = ${JSON.stringify(invalid)}, valid = ${JSON.stringify(valid)};
const input = document.querySelector('textarea');
function reply(text) { const node = document.createElement('div'); node.className = 'prose-code-custom'; node.textContent = text; document.body.append(node); }
if (sessionStorage.getItem('historic')) reply(invalid);
function send() {
  if (!input.value) return;
  const value = input.value;
  const sends = Number(sessionStorage.getItem('sends') || 0) + 1;
  sessionStorage.setItem('sends', sends);
  if (sends === 1) { input.value = ''; if (mode === 'not-sent-switch') document.querySelector('button').disabled = true; sessionStorage.setItem('historic','1'); setTimeout(() => reply(invalid), 30); return; }
  if (value.startsWith('本地工具执行结果')) {
    sessionStorage.setItem('feedback', value);
    if (['reload', 'after-switch', 'after-generation', 'after-pause'].includes(mode)) return;
    input.value = '';
    setTimeout(() => reply(mode === 'three' ? invalid : valid), 50);
    return;
  }
  if (mode === 'after-switch' || mode === 'after-generation') {
    input.value = '新任务草稿';
    setTimeout(() => reply(valid), 50);
    setTimeout(() => { input.value = ''; }, 3000);
  } else input.value = '';
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error('等待预期状态超时');
}
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = findById(child, id); if (found) return found; }
  return null;
}
async function panelNode(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  return findById(tree.root, id);
}
async function click(win, node) {
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: node.nodeId});
  const q = box.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  win.webContents.sendInputEvent({type:'mouseMove', x, y});
  win.webContents.sendInputEvent({type:'mouseDown', x, y, button:'left', clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp', x, y, button:'left', clickCount:1});
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('format-feedback-test');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type':'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show:false, width:1100, height:800, webPreferences:{session:ses, preload:path.join(__dirname, '..', '..', 'preload.js'), contextIsolation:true, sandbox:false, nodeIntegration:false}});
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/test');
  await delay(1500);
  await win.webContents.executeJavaScript("document.querySelector('textarea').value='查看文件';document.querySelector('textarea').focus()");
  win.webContents.sendInputEvent({type:'keyDown', keyCode:'Enter'}); win.webContents.sendInputEvent({type:'keyUp', keyCode:'Enter'});
  win.webContents.debugger.attach('1.3');
  if (mode === 'valid' || mode === 'three') {
    if (mode === 'valid') await until(() => calls.length === 1);
    else await until(async () => (await ledger.list('/chat/c/test')).filter(e => e.kind === 'format_error').length === 3);
    await delay(1800);
    const records = await ledger.list('/chat/c/test');
    const errors = records.filter(e => e.kind === 'format_error');
    const sends = await win.webContents.executeJavaScript("Number(sessionStorage.getItem('sends'))");
    const feedback = await win.webContents.executeJavaScript("sessionStorage.getItem('feedback')");
    if (!feedback || !feedback.includes('格式') || !feedback.includes('重写')) throw new Error('没有发送明确的格式错误反馈');
    if (mode === 'valid' && (errors.length !== 1 || calls.length !== 1 || calls[0].path !== 'D:/Documents' || sends !== 2)) throw new Error(`合法请求未恰好执行一次: ${calls.length}, ${errors.length}, ${sends}`);
    if (mode === 'three' && (errors.length !== 3 || calls.length || sends !== 3)) throw new Error(`第三次格式错误后没有停止: ${calls.length}, ${errors.length}, ${sends}`);
    if (errors.some(e => e.request !== null || e.state !== 'format_error')) throw new Error('格式错误记录未明确区分本地执行');
  } else if (mode === 'after-pause') {
    await until(() => markStarted);
    await win.webContents.executeJavaScript("document.querySelector('textarea').value='用户草稿'");
    releaseMark();
    await until(async () => { const button = await panelNode(win, 'send'); return button && !(button.attributes || []).includes('hidden'); });
    await win.webContents.executeJavaScript("document.querySelector('textarea').value=''");
    await click(win, await panelNode(win, 'send'));
    await until(async () => Boolean(await win.webContents.executeJavaScript("sessionStorage.getItem('feedback')")));
    await click(win, await panelNode(win, 'pause'));
    await until(async () => (await ledger.list('/chat/c/test'))[0]?.delivery === 'unknown');
    await delay(300);
    const button = await panelNode(win, 'send');
    const status = await panelNode(win, 'status');
    if (!button || !(button.attributes || []).includes('hidden')) throw new Error('发送状态未知后仍显示重复发送入口');
    if (!status || !JSON.stringify(status).includes('状态未知')) throw new Error('未提示发送状态未知');
    await click(win, await panelNode(win, 'pause'));
    await delay(500);
    if (!((await panelNode(win, 'send')).attributes || []).includes('hidden')) throw new Error('恢复后重新出现重复发送入口');
    if (Number(await win.webContents.executeJavaScript("sessionStorage.getItem('sends')")) !== 2) throw new Error('恢复后自动重发');
  } else if (mode === 'not-sent-switch') {
    await until(async () => (await win.webContents.executeJavaScript("document.querySelector('textarea').value")).startsWith('本地工具执行结果'));
    await win.webContents.executeJavaScript("document.querySelector('textarea').value='用户草稿'");
    await until(() => notSentStarted);
    await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
    await delay(700);
    releaseNotSent(); await delay(700);
    const status = await panelNode(win, 'status');
    const oldRecord = (await ledger.list('/chat/c/test'))[0];
    if (!oldRecord || oldRecord.delivery !== 'not_sent') throw new Error('旧记录未标记未发送');
    if (status && JSON.stringify(status).includes('聊天框内容已变化，结果未发送')) throw new Error('旧流程覆盖了新对话状态');
  } else if (mode === 'after-switch' || mode === 'after-generation') {
    await until(async () => Boolean(await win.webContents.executeJavaScript("sessionStorage.getItem('feedback')")));
    if (mode === 'after-switch') {
      await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
      await delay(700);
    }
    await win.webContents.executeJavaScript("document.querySelector('textarea').value='新任务';document.querySelector('textarea').focus()");
    win.webContents.sendInputEvent({type:'keyDown', keyCode:'Enter'}); win.webContents.sendInputEvent({type:'keyUp', keyCode:'Enter'});
    const watchUntil = Date.now() + 2700;
    while (Date.now() < watchUntil) {
      const status = await panelNode(win, 'status');
      if (status && JSON.stringify(status).includes('已触发发送，但无法确认')) throw new Error('旧发送流程覆盖了新任务状态');
      await delay(50);
    }
    await until(() => calls.length === 1);
    await delay(2600);
    const status = await panelNode(win, 'status');
    const oldRecord = (await ledger.list('/chat/c/test')).find(e => e.kind === 'format_error');
    if (!oldRecord || oldRecord.delivery !== 'unknown') throw new Error('旧结果发送状态应为未知');
    if (!status || JSON.stringify(status).includes('已触发发送，但无法确认')) throw new Error('旧发送流程覆盖了新任务状态');
  } else if (mode === 'reload') {
    await until(async () => Number(await win.webContents.executeJavaScript("sessionStorage.getItem('sends')")) === 2);
    await win.reload(); await delay(2400);
    const records = await ledger.list('/chat/c/test');
    const sends = await win.webContents.executeJavaScript("Number(sessionStorage.getItem('sends'))");
    if (calls.length || sends !== 2 || records.length !== 1 || !['sending', 'unknown'].includes(records[0].delivery)) throw new Error(`刷新后重复发送或丢失发送未知状态: calls=${calls.length}, sends=${sends}, records=${records.length}, delivery=${records[0]?.delivery}`);
    const status = await panelNode(win, 'status');
    if (!status || !JSON.stringify(status).includes('发送状态未知')) throw new Error('刷新后未提示发送状态未知');
  } else {
    await until(() => markStarted);
    if (mode === 'draft') await win.webContents.executeJavaScript("document.querySelector('textarea').value='用户草稿'");
    if (mode === 'switch') await win.webContents.executeJavaScript("history.pushState({}, '', '/chat/c/other')");
    if (mode === 'pause' || mode === 'pause-resume') await click(win, await panelNode(win, 'pause'));
    if (mode === 'pause-resume') await click(win, await panelNode(win, 'pause'));
    if (mode === 'generation') {
      await win.webContents.executeJavaScript("document.querySelector('textarea').value='新的用户任务';document.querySelector('textarea').focus()");
      win.webContents.sendInputEvent({type:'keyDown', keyCode:'Enter'}); win.webContents.sendInputEvent({type:'keyUp', keyCode:'Enter'});
    }
    releaseMark(); await delay(2200);
    const value = await win.webContents.executeJavaScript("document.querySelector('textarea').value");
    const feedback = await win.webContents.executeJavaScript("sessionStorage.getItem('feedback')");
    if ((mode === 'draft' && value !== '用户草稿') || (mode !== 'draft' && value)) throw new Error(`旧结果覆盖输入框: ${value}`);
    if (feedback || calls.length) throw new Error('旧格式错误结果被发送或执行');
    if (mode === 'pause' || mode === 'pause-resume') {
      const button = await panelNode(win, 'send');
      if (!button || (button.attributes || []).includes('hidden')) throw new Error('发送前暂停后未保留手动发送入口');
    }
  }
  win.webContents.debugger.detach(); process.stdout.write('fixture passed\n'); app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
