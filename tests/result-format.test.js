'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {resultText} = require('../result-format');

function parse(text) {
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
}

test('已触及采集上限的超长命令错误输出在回填时明确截短，保留原始结果', () => {
  const result = {ok: true, tool: 'run_command', exitCode: 0, truncated: true, stdout: '实际输出', stderr: '甲'.repeat(102400)};
  const text = resultText(result);
  const feedback = parse(text);
  assert.equal(result.stderr.length, 102400);
  assert.equal(feedback.stdout, result.stdout);
  assert.equal(feedback.stderrFeedbackOmittedCharacters, 102400 - 4096 - 1024);
  assert.match(feedback.stderr, /命令输出本身已被采集上限截断/);
  assert.equal(feedback.truncated, true);
  assert.ok(text.length < 7000);
});

test('未截断的命令和其他工具结果保持原样', () => {
  const command = {ok: true, tool: 'run_command', truncated: false, stdout: '', stderr: '警告'.repeat(5000)};
  const file = {ok: true, tool: 'read_file', content: 'hello'};
  assert.deepEqual(parse(resultText(command)), command);
  assert.deepEqual(parse(resultText(file)), file);
});
