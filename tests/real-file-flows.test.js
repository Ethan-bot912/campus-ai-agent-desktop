'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

for (const [mode, title] of [
  ['read-two', '两份真实临时文件经过目录、读取、回填和模型替身'],
  ['deny', '拒绝真实临时文件写入后文件不变且后续工具停止'],
  ['create', '允许一次后新建临时文件并读取验证'],
  ['overwrite', '覆盖预览与实际写入内容一致，授权后读回验证']
]) {
  test(title, {timeout: 60000}, async t => {
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'real-file-flows-electron.js'), mode], {env, windowsHide: true});
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
