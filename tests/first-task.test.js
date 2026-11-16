'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');

test('离线任务从真实文件读取到网页回填和面板报告', {timeout: 45000}, async t => {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'first-task-electron.js')], {env, windowsHide: true});
  const stopChild = () => { if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill(); };
  t.signal.addEventListener('abort', stopChild, {once: true});
  t.after(() => {
    t.signal.removeEventListener('abort', stopChild);
    stopChild();
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /fixture passed/);
});
