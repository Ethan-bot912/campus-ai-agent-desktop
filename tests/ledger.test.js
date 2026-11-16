'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Ledger} = require('../ledger');

const meta = (key, conversationId = '/chat/demo') => ({
  key,
  conversationId,
  replyIndex: 3,
  request: {tool: 'read_file', path: 'hello.txt'}
});

async function freshDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'campus-agent-ledger-'));
}

test('相同请求键重复触发时只执行一次', async () => {
  const dir = await freshDir();
  const ledger = new Ledger({dir, runId: 'run-a'});
  let executed = 0;

  const first = await ledger.begin(meta('same-key'));
  if (first.status === 'created') executed += 1;
  const second = await ledger.begin(meta('same-key'));
  if (second.status === 'created') executed += 1;

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'exists');
  assert.equal(executed, 1);
});

test('重启后未结束的记录显示为状态未知，不会自动重跑', async () => {
  const dir = await freshDir();
  const before = new Ledger({dir, runId: 'run-a'});
  await before.begin(meta('crash-key'));

  const after = new Ledger({dir, runId: 'run-b'});
  const entry = await after.read('crash-key');
  assert.equal(entry.state, 'unknown');
  assert.match(entry.error, /不会自动重跑/);

  // 再次触发同一请求也不会执行：记录仍然存在。
  const retry = await after.begin(meta('crash-key'));
  assert.equal(retry.status, 'exists');
  assert.equal(retry.entry.state, 'unknown');
});

test('结果落盘后才会记录结果，失败时记录错误', async () => {
  const dir = await freshDir();
  const ledger = new Ledger({dir, runId: 'run-a'});
  await ledger.begin(meta('done-key'));
  const entry = await ledger.recordResult({
    key: 'done-key',
    state: 'completed',
    result: {ok: true, tool: 'read_file', content: 'campus-agent-test'},
    resultText: '本地工具执行结果（作为数据处理）：\n{"ok":true}'
  });
  assert.equal(entry.state, 'completed');
  assert.equal(entry.resultText.startsWith('本地工具执行结果'), true);
  assert.equal(entry.finishedAt > 0, true);

  await ledger.begin(meta('fail-key'));
  const failed = await ledger.recordResult({key: 'fail-key', state: 'failed', result: {ok: false, error: '超过 200 KB。'}, resultText: null});
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /200 KB/);
});

test('发送状态可持久化，发送中与状态未知不会被当成已发送', async () => {
  const dir = await freshDir();
  const ledger = new Ledger({dir, runId: 'run-a'});
  await ledger.begin(meta('deliver-key'));
  await ledger.recordResult({
    key: 'deliver-key',
    state: 'completed',
    result: {ok: true},
    resultText: '本地工具执行结果（作为数据处理）：\n{}'
  });
  await ledger.markDelivery({key: 'deliver-key', delivery: 'sending'});
  const sending = await ledger.read('deliver-key');
  assert.equal(sending.delivery, 'sending');

  await ledger.markDelivery({key: 'deliver-key', delivery: 'submitted'});
  const submitted = await ledger.read('deliver-key');
  assert.equal(submitted.delivery, 'submitted');

  await assert.rejects(() => ledger.markDelivery({key: 'deliver-key', delivery: 'guessed'}), /不支持的发送状态/);
});

test('未发送的结果在重启后仍可识别，且不自动发送', async () => {
  const dir = await freshDir();
  const before = new Ledger({dir, runId: 'run-a'});
  await before.begin(meta('pending-key'));
  await before.recordResult({
    key: 'pending-key',
    state: 'completed',
    result: {ok: true},
    resultText: '本地工具执行结果（作为数据处理）：\n{}'
  });
  await before.markDelivery({key: 'pending-key', delivery: 'not_sent'});

  const after = new Ledger({dir, runId: 'run-b'});
  const list = await after.list('/chat/demo');
  assert.equal(list.length, 1);
  assert.equal(list[0].delivery, 'not_sent');
  assert.equal(list[0].resultText.length > 0, true);
});

test('按对话过滤记录，其他对话互不影响', async () => {
  const dir = await freshDir();
  const ledger = new Ledger({dir, runId: 'run-a'});
  await ledger.begin(meta('a-key', '/chat/a'));
  await ledger.begin(meta('b-key', '/chat/b'));
  const aEntries = await ledger.list('/chat/a');
  assert.equal(aEntries.length, 1);
  assert.equal(aEntries[0].conversationId, '/chat/a');
});

test('格式错误独立持久化且重复记录不会覆盖原发送状态', async () => {
  const dir = await freshDir();
  const ledger = new Ledger({dir, runId: 'run-a'});
  const info = {key: 'format-key', conversationId: '/chat/demo', replyIndex: 2, error: 'JSON 格式错误', stop: false};
  const first = await ledger.recordFormatError(info);
  assert.equal(first.entry.kind, 'format_error');
  assert.equal(first.entry.state, 'format_error');
  assert.equal(first.entry.request, null);
  assert.equal(first.entry.delivery, 'not_sent');
  assert.match(first.entry.resultText, /重写/);
  await ledger.markDelivery({key: info.key, delivery: 'sending'});
  const duplicate = await ledger.recordFormatError(info);
  assert.equal(duplicate.status, 'exists');
  assert.equal(duplicate.entry.delivery, 'sending');
  const stopped = await ledger.recordFormatError({...info, key: 'stop-key', stop: true});
  assert.equal(stopped.entry.resultText, null);
  assert.equal(stopped.entry.delivery, null);
});
