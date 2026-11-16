'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

for (const [mode, title] of [['reject', '当前回填出现服务拒绝时停止后续操作且记录发送状态未知'], ['baseline', '历史服务错误不会误判为当前回填失败'], ['switch', '切换对话后出现的错误不会归到原回填']]) {
  test(title, {timeout: 25000}, async () => {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'delivery-error-electron.js'), mode], {env, windowsHide: true});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /fixture passed/);
  });
}
