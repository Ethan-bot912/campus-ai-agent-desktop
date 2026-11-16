'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

for (const [mode, title] of [
  ['lifecycle', '新对话、多轮工具、补充和新任务各自归属正确'],
  ['approval-switch', '等待授权时切换对话不会执行旧请求'],
  ['approval-pause', '等待授权时暂停不会执行旧请求'],
  ['approval-deny', '拒绝授权后停止后续工具执行'],
  ['deny-render-switch', '拒绝记录加载期间切换对话不污染新任务'],
  ['approval-cancel-history', '取消授权后任务历史可查看未执行步骤'],
  ['creation-pause', '创建任务落盘期间暂停不能执行旧请求'],
  ['creation-switch', '创建任务落盘期间切换对话不能执行旧请求'],
  ['end-race', '结束任务并立即发消息时等待清理后创建新任务'],
  ['before-execute', '执行前的任务记录落盘期间暂停会阻止实际执行'],
  ['before-execute-switch', '执行前的任务记录落盘期间切换对话会阻止实际执行'],
  ['execute-switch', '旧任务执行结果返回后不会污染新对话'],
  ['execute-end', '运行期间结束任务显示未知，不声称已完成'],
  ['reload', '刷新后未结束任务变为未知且不自动重跑'],
  ['recover-race', '刷新恢复期间立即开始新任务不会误标未知'],
  ['delivery-unknown', '发送结果状态未知后延迟请求不得继续执行'],
  ['delivery-mark-failed', '发送状态未知落盘失败后仍停止后续工具'],
  ['delivery-submitted-failed', '发送成功标记失败后停止后续工具'],
  ['scope-during-send', '发送结果期间更改范围后状态未知且停止'],
  ['step-save-failed', '工具完成后步骤记录失败时停在未知且不自动重跑'],
  ['ledger-fails-once', '工具结果首次落盘失败不得伪报失败或重跑'],
  ['ledger-fails-always', '工具结果持续落盘失败不得伪报失败或重跑'],
  ['existing-executing', '已有执行中记录时停止且不执行后续请求'],
  ['existing-unknown', '已有执行状态未知记录时停止且不执行后续请求'],
  ['existing-sending', '已有发送中记录时停止且不执行后续请求'],
  ['existing-delivery-unknown', '已有发送未知记录时停止且不执行后续请求']
]) {
  test(title, {timeout: 45000}, async () => {
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'task-workbench-electron.js'), mode], {env, windowsHide: true});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /fixture passed/);
  });
}
