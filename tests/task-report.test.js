'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseModelProgress, summarizeLocalEvidence, trackFailure} = require('../task-report');

const block = json => `模型说明\nCAMPUS_AGENT_PROGRESS\n${json}\nCAMPUS_AGENT_PROGRESS_END\n原始回复`;

test('只把独立标记中的结构化进度作为模型报告', () => {
  assert.deepEqual(parseModelProgress('这是普通回复'), {status: 'none'});
  assert.deepEqual(parseModelProgress(block('{"goal":"整理文件","next":"读取目录","blockers":["等待授权"]}')), {
    status: 'ok', report: {goal: '整理文件', next: '读取目录', blockers: ['等待授权']}
  });
});

test('拒绝格式错误、额外字段、多个区块及与工具请求混用的进度', () => {
  for (const text of [
    block('{broken}'),
    block('{"goal":"整理","verified":true}'),
    block('{"goal":"整理"}') + '\n' + block('{"goal":"另一个"}'),
    block('{"goal":"整理"}') + '\nPC_TOOL_REQUEST\n{}\nPC_TOOL_END',
    'CAMPUS_AGENT_PROGRESS\n{"goal":"整理"}',
    block('{"goal":{}}'),
    block('{}')
  ]) assert.equal(parseModelProgress(text).status, 'invalid', text);
});

test('任务成果只列出本机确实完成的文件操作，路径来自工具结果', () => {
  const entries = [
    {key: 'read', state: 'completed', request: {tool: 'read_file', path: 'requested'}, result: {ok: true, tool: 'read_file', path: 'D:/real.txt', content: 'secret'}},
    {key: 'write', state: 'completed', request: {tool: 'write_file'}, result: {ok: true, tool: 'write_file', path: 'D:/out.txt'}},
    {key: 'move', state: 'completed', request: {tool: 'move'}, result: {ok: true, tool: 'move', from: 'D:/a', to: 'D:/b'}},
    {key: 'delete', state: 'failed', request: {tool: 'delete'}, result: {ok: false, tool: 'delete', path: 'D:/b'}},
    {key: 'unknown', state: 'unknown', request: {tool: 'write_file'}, result: {ok: true, tool: 'write_file', path: 'D:/unsafe'}},
    {key: 'mismatch', state: 'completed', request: {tool: 'read_file'}, result: {ok: true, tool: 'write_file', path: 'D:/wrong'}},
    {key: 'prototype', state: 'completed', request: {tool: 'toString'}, result: {ok: true, tool: 'toString', path: 'D:/wrong'}}
  ];
  const report = summarizeLocalEvidence(entries);
  assert.deepEqual(report.files, [
    {key: 'read', operation: '读取', path: 'D:/real.txt'},
    {key: 'write', operation: '写入', path: 'D:/out.txt'},
    {key: 'move', operation: '移动', from: 'D:/a', to: 'D:/b'}
  ]);
  assert.deepEqual(report.verification, {status: 'unverified', message: '未验证', checks: [{writeKey: 'write', path: 'D:/out.txt', status: 'unavailable'}]});
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('命令只报告实际状态，不从退出码或模型描述推断验证通过', () => {
  const report = summarizeLocalEvidence([
    {key: 'cmd', state: 'completed', request: {tool: 'run_command'}, result: {ok: true, tool: 'run_command', exitCode: 0, timedOut: false, cancelled: false, truncated: true, stdout: 'passed', stderr: 'warning'}},
    {key: 'timeout', state: 'failed', request: {tool: 'run_command'}, result: {ok: false, tool: 'run_command', exitCode: null, timedOut: true, cancelled: false, truncated: false, stderr: ''}},
    {key: 'denied', state: 'denied', request: {tool: 'run_command'}, result: {ok: false, denied: true}}
  ]);
  assert.deepEqual(report.commands, [
    {key: 'cmd', state: 'completed', exitCode: 0, timedOut: false, cancelled: false, truncated: true, stderrHasOutput: true},
    {key: 'timeout', state: 'failed', exitCode: null, timedOut: true, cancelled: false, truncated: false, stderrHasOutput: false}
  ]);
  assert.equal(report.verification.status, 'unverified');
  assert.ok(!JSON.stringify(report).includes('passed'));
});

test('边界输入非法时直接报错，不把缺失状态伪装成已知信息', () => {
  assert.throws(() => parseModelProgress(null), TypeError);
  assert.throws(() => summarizeLocalEvidence(null), TypeError);
  const report = summarizeLocalEvidence([{key: 'x', state: 'completed', request: {tool: 'run_command'}, result: {ok: true, tool: 'run_command'}}]);
  assert.deepEqual(report.commands[0], {key: 'x', state: 'completed', exitCode: null, timedOut: null, cancelled: null, truncated: null, stderrHasOutput: null});
});

test('本机写后读只对严格同一路径、明确顺序及可重建字节比较', () => {
  const write = {key:'w',state:'completed',startedAt:10,finishedAt:20,request:{tool:'write_file',content:'\ufeff甲'},result:{ok:true,tool:'write_file',path:'D:/a.txt',bytes:6}};
  const read = {key:'r',state:'completed',startedAt:21,finishedAt:22,request:{tool:'read_file'},result:{ok:true,tool:'read_file',path:'D:/a.txt',bytes:6,content:'甲'}};
  assert.deepEqual(summarizeLocalEvidence([write,read]).verification.checks, [{writeKey:'w',readKey:'r',path:'D:/a.txt',status:'match'}]);
  const different = {...read,result:{...read.result,content:'乙'}};
  assert.equal(summarizeLocalEvidence([write,different]).verification.checks[0].status,'mismatch');
  for (const bad of [{...read,startedAt:19}, {...read,startedAt:undefined}, {...read,result:{...read.result,path:'d:/a.txt'}}, {...read,result:{...read.result,bytes:5}}]) {
    assert.equal(summarizeLocalEvidence([write,bad]).verification.checks[0].status,'unavailable');
  }
  assert.equal(summarizeLocalEvidence([read,write]).verification.checks[0].status,'unavailable');
});


test('连续失败只累计相同操作或明确相同的本机错误，成功后重置', () => {
  const fail = (code) => ({state:'failed',result:{ok:false,code}});
  const one = {tool:'read_file',path:'D:/a'}, two = {tool:'read_file',path:'D:/b'};
  let run = trackFailure(null, one, fail('ENOENT'));
  run = trackFailure(run, one, fail('EACCES'));
  assert.equal(run.operationCount, 2);
  assert.equal(run.errorCount, 1);
  run = trackFailure(run, two, fail('EACCES'));
  assert.equal(run.operationCount, 1);
  assert.equal(run.errorCount, 2);
  run = trackFailure(run, one, fail('EACCES'));
  assert.equal(run.errorCount, 3);
  assert.equal(trackFailure(run, one, {state:'completed',result:{ok:true}}), null);
  assert.equal(trackFailure(run, one, {state:'unknown'}), run);
});
