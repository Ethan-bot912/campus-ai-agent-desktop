'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

for (const [mode, title] of [
  ['valid', '格式错误反馈后合法请求只执行一次'],
  ['three', '同一任务连续三次格式错误后停止'],
  ['draft', '回填标记期间出现草稿时不覆盖或发送'],
  ['reload', '格式错误反馈发送状态未知时刷新不重发'],
  ['switch', '回填标记期间切换对话不写入或发送'],
  ['pause', '回填标记期间暂停不写入或发送'],
  ['pause-resume', '回填标记期间暂停后恢复保留手动待发送入口'],
  ['generation', '回填标记期间开始新任务不写入或发送旧结果'],
  ['after-switch', '点击发送后切换对话不覆盖新任务状态'],
  ['after-generation', '点击发送后开始新任务不覆盖新任务状态'],
  ['after-pause', '点击发送后暂停不得留下重复发送入口'],
  ['not-sent-switch', '记录未发送状态期间切换对话不覆盖新状态']
]) {
  test(title, {timeout: 30000}, async () => {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'format-feedback-electron.js'), mode], {env, windowsHide: true});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /fixture passed/);
  });
}
