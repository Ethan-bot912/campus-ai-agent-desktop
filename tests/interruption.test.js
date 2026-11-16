'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

for (const [mode, title] of [
  ['pause', '暂停时取消待处理命令授权'],
  ['draft', '有未发送草稿时保留草稿且不执行工具'],
  ['draft-clear', '清空草稿后同一请求继续且只执行一次'],
  ['reload', '发送状态未知时刷新不会自动重跑或重发']
]) {
  test(title, {timeout: 25000}, async () => {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'interruption-electron.js'), mode], {env, windowsHide: true});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /fixture passed/);
  });
}
