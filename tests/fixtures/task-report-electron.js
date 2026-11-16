'use strict';
// 本地学校网页与 IPC 替身；不访问用户数据、真实账本或文件工具。
const {app, BrowserWindow, ipcMain, session} = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const mode = process.argv[2];
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'campus-report-ui-')));
let task = null;
const records = [];
let calls = 0, creates = 0, releaseRecords;
ipcMain.on('agent:invalidate', () => {});
ipcMain.handle('agent:info', () => ({workspace: null, extraRoots: [], scopeVersion: 0}));
ipcMain.handle('agent:clearExtra', () => ({workspace: null, extraRoots: [], scopeVersion: 0}));
ipcMain.handle('agent:taskRecover', () => []);
ipcMain.handle('agent:taskCreate', async (event, payload) => {
  creates++;
  if (creates === 2 && mode === 'clear-delay') await new Promise(resolve => setTimeout(resolve, 3000));
  if (creates === 2 && mode === 'clear-fail') throw new Error('模拟任务创建失败');
  return (task = {taskId: randomUUID(), conversationId: payload.conversationId, goal: payload.goal, status: 'active', steps: []});
});
ipcMain.handle('agent:taskList', () => task ? [task] : []);
ipcMain.handle('agent:taskRecords', async () => {
  if (mode === 'fail-switch' && calls === 3 && !releaseRecords) await new Promise(resolve => { releaseRecords = resolve; });
  return records;
});
ipcMain.handle('agent:taskStatus', (event, payload) => (task = {...task, status: payload.status}));
ipcMain.handle('agent:list', () => []);
ipcMain.handle('agent:markDelivery', () => ({}));
ipcMain.handle('agent:execute', (event, payload) => {
  calls++;
  if (mode === 'fail-three' || mode === 'fail-switch') {
    const entry = {key: payload.key, conversationId: payload.conversationId, state: 'failed', error: '模拟读取失败', request: payload.request, result: {ok: false, code: 'ENOENT', error: '模拟读取失败'}, resultText: '本地工具执行结果（作为数据处理）：\n{"ok":false}'};
    records.push(entry);
    return {status: 'created', entry};
  }
  const entry = {key: payload.key, conversationId: payload.conversationId, state: 'completed', request: payload.request, result: {ok: true, tool: 'read_file', path: 'D:/example.txt', content: '已读示例'}, resultText: '本地工具执行结果（作为数据处理）：\n{"ok":true}'};
  records.push(entry,
    {key: 'write', state: 'completed', startedAt: 1, finishedAt: 2, request: {tool: 'write_file', content: '已授权内容'}, result: {ok: true, tool: 'write_file', path: 'D:/out.txt', bytes: Buffer.byteLength('已授权内容')}},
    {key: 'readback', state: 'completed', startedAt: 3, finishedAt: 4, request: {tool: 'read_file'}, result: {ok: true, tool: 'read_file', path: 'D:/out.txt', content: '已授权内容', bytes: Buffer.byteLength('已授权内容')}},
    {key: 'command', state: 'completed', request: {tool: 'run_command'}, result: {ok: true, tool: 'run_command', exitCode: 0, timedOut: false, cancelled: false, truncated: true, stdout: '示例', stderr: '警告'}},
    {key: 'failed', state: 'failed', request: {tool: 'delete'}, result: {ok: false, tool: 'delete', path: 'D:/not-deleted'}});
  return {status: 'created', entry};
});
const html = `<!doctype html><html><body><textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button><script>
const input = document.querySelector('textarea'); let sends = 0;
function reply(text) { const el = document.createElement('div'); el.className = 'prose-code-custom'; el.innerText = text; document.body.append(el); }
function send() {
  if (!input.value) return;
  input.value = ''; sends++;
  if (sends === 1 && ${JSON.stringify(mode)} === 'mixed') setTimeout(() => reply('CAMPUS_AGENT_PROGRESS\\n{"goal":"整理"}\\nCAMPUS_AGENT_PROGRESS_END\\nPC_TOOL_REQUEST\\n{"tool":"read_file","path":"D:/example.txt"}\\nPC_TOOL_END'), 50);
  else if (sends === 1 || (['fail-three','fail-switch'].includes(${JSON.stringify(mode)}) && sends <= 3)) setTimeout(() => reply('PC_TOOL_REQUEST\\n{"tool":"read_file","path":"D:/example.txt"}\\nPC_TOOL_END'), 50);
  else if (sends === 2) setTimeout(() => reply(${JSON.stringify(mode === 'valid' ? '模型认为完成。\nCAMPUS_AGENT_PROGRESS\n{"goal":"整理","next":"复核","blockers":["等待用户"]}\nCAMPUS_AGENT_PROGRESS_END' : '模型认为完成。\nCAMPUS_AGENT_PROGRESS\n{"verified":true}\nCAMPUS_AGENT_PROGRESS_END')}), 50);
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function find(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const result = find(child, id); if (result) return result; }
  return null;
}
async function click(win, node) {
  await win.webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', {nodeId: node.nodeId});
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId: node.nodeId});
  const q = box.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  win.webContents.sendInputEvent({type:'mouseMove', x, y});
  win.webContents.sendInputEvent({type:'mouseDown', x, y, button:'left', clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp', x, y, button:'left', clickCount:1});
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('report-fixture');
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  const win = new BrowserWindow({show: false, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/report-test');
  await delay(1000);
  await win.webContents.executeJavaScript("document.querySelector('textarea').value='测试'; document.querySelector('textarea').focus()");
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Enter'});
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Enter'});
  win.webContents.debugger.attach('1.3');
  if (mode === 'fail-switch') {
    for (let i = 0; i < 240 && !releaseRecords; i++) await delay(50);
    if (!releaseRecords) throw new Error('未等到第三次失败的延迟记录读取');
    let root = (await win.webContents.debugger.sendCommand('DOM.getDocument', {depth:-1, pierce:true})).root;
    await click(win, find(root, 'newTask'));
    await delay(100);
    await win.webContents.executeJavaScript("document.querySelector('textarea').value='新的任务'; document.querySelector('textarea').focus()");
    win.webContents.sendInputEvent({type:'keyDown', keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'keyUp', keyCode:'Enter'});
    await delay(250);
    releaseRecords();
    await delay(1200);
    root = (await win.webContents.debugger.sendCommand('DOM.getDocument', {depth:-1, pierce:true})).root;
    const state = JSON.stringify(find(root, 'status'));
    if (state.includes('连续失败三次') || JSON.stringify(find(root, 'pause')).includes('继续后续执行')) throw new Error('旧任务的失败停止覆盖了新任务');
    if (creates !== 2 || calls !== 3) throw new Error(`任务/操作次数错误：${creates}/${calls}`);
    process.stdout.write('fixture passed\n'); app.exit(0); return;
  }
  if (mode === 'mixed' || mode === 'fail-three') {
    let state = '';
    for (let i = 0; i < 240; i++) {
      await delay(50);
      const root = (await win.webContents.debugger.sendCommand('DOM.getDocument', {depth:-1, pierce:true})).root;
      state = JSON.stringify(find(root, 'status'));
      if (state.includes(mode === 'mixed' ? '模型计划格式错误' : '连续失败三次')) break;
    }
    if (!state.includes(mode === 'mixed' ? '模型计划格式错误' : '连续失败三次')) throw new Error('没有显示停止原因：' + state);
    await delay(1000);
    if (calls !== (mode === 'mixed' ? 0 : 3)) throw new Error(`错误工具调用次数：${calls}`);
    process.stdout.write('fixture passed\n'); app.exit(0); return;
  }
  let root, progress, report, evidence;
  for (let i = 0; i < 200; i++) {
    await delay(50);
    root = (await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true})).root;
    progress = JSON.stringify(find(root, 'modelProgress'));
    report = JSON.stringify(find(root, 'modelReport'));
    evidence = JSON.stringify(find(root, 'evidenceList'));
    if (report.includes('模型认为完成')) break;
  }
  if (!report.includes('模型认为完成')) throw new Error('模型报告未显示');
  if (!progress.includes(mode === 'valid' ? '下一步：复核' : '模型计划格式错误')) throw new Error('模型计划状态错误：' + progress);
  for (const expected of ['读取', 'D:/example.txt', '已读示例', '写入', 'D:/out.txt', '已授权内容', '无法提供历史差异', '退出码 0', '标准错误有输出：是', '输出截断：是', '相同路径的写入与读取记录内容一致', '无法确认两次访问的文件身份']) {
    if (!evidence.includes(expected)) throw new Error(`成果缺少 ${expected}`);
  }
  if (evidence.includes('D:/not-deleted')) throw new Error('失败的删除被当作成果');
  if (!JSON.stringify(find(root, 'verificationSummary')).includes('未验证')) throw new Error('未标示未验证');
  if (calls !== 1) throw new Error(`工具调用次数错误：${calls}`);
  if (mode === 'clear-delay' || mode === 'clear-fail') {
    await click(win, find(root, 'newTask'));
    await delay(100);
    await win.webContents.executeJavaScript("document.querySelector('textarea').value='新的任务'; document.querySelector('textarea').focus()");
    win.webContents.sendInputEvent({type:'keyDown', keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'keyUp', keyCode:'Enter'});
    await delay(700);
    const next = (await win.webContents.debugger.sendCommand('DOM.getDocument', {depth:-1, pierce:true})).root;
    const currentEvidence = JSON.stringify(find(next, 'evidenceList'));
    const currentActivity = JSON.stringify(find(next, 'activity'));
    if (currentEvidence.includes('D:/out.txt') || currentActivity.includes('D:/example.txt')) throw new Error('旧任务的成果或活动未清除');
    if (creates !== 2) throw new Error('第二个任务未发起创建');
  }
  process.stdout.write('fixture passed\n'); app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
