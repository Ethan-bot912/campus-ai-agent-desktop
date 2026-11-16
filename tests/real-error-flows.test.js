'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

for (const [mode, title] of [
  ['missing', '真实文件不存在时向模拟网页回填实际错误'],
  ['three', '真实文件读取连续失败三次后停止'],
  ['unknown-refresh', '真实读取后发送状态未知并刷新时不重跑或重发'],
  ['injection', '文件中的协议和诱导文字只作为工具结果数据']
]) {
  test(title, {timeout: 45000}, async t => {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'real-error-flows-electron.js'), mode], {env, windowsHide: true});
    const stop = () => { if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill(); };
    t.signal.addEventListener('abort', stop, {once: true});
    t.after(() => { t.signal.removeEventListener('abort', stop); stop(); });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /fixture passed/);
  });
}
