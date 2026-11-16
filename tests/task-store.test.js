'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {TaskStore, TASK_STATES} = require('../task-store');

async function makeStore(t, runId = 'run-1') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campus-task-store-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return {store: new TaskStore({dir, runId}), dir};
}
const key = n => n.toString(16).padStart(64, '0');
const ref = (task, conversationId = task.conversationId) => ({taskId: task.taskId, conversationId});

test('同一对话的任务独立、按对话读取，目标与状态持久化', async t => {
  const {store, dir} = await makeStore(t);
  const first = await store.create({conversationId: '/chat/c/a', goal: '列出文件'});
  const second = await store.create({conversationId: '/chat/c/a', goal: '检查文件'});
  await store.create({conversationId: '/chat/c/b', goal: '其他对话'});
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(first.status, 'active');
  assert.equal(first.createdAt, first.updatedAt);
  assert.equal((await store.list({conversationId: '/chat/c/a'})).length, 2);
  assert.equal(await store.get(ref(first, '/chat/c/b')), null);
  await store.setStatus({...ref(first), status: 'waiting_model'});
  const loaded = await new TaskStore({dir, runId: 'run-1'}).get(ref(first));
  assert.equal(loaded.goal, '列出文件');
  assert.equal(loaded.status, 'waiting_model');
  assert.equal((await store.get(ref(second))).status, 'active');
});

test('并发步骤更新不丢失，同一工具的后续状态更新原步骤', async t => {
  const {store, dir} = await makeStore(t);
  const otherInstance = new TaskStore({dir, runId: 'run-1'});
  const task = await store.create({conversationId: '/chat/c/a', goal: '读取并验证'});
  await Promise.all(Array.from({length: 16}, (_, i) => (i % 2 ? store : otherInstance).recordStep({
    ...ref(task), step: {key: key(i), tool: 'read_file', state: 'completed', purpose: i === 2 ? 'verification' : 'tool', content: '不应保存的文件内容'}
  })));
  await store.recordStep({...ref(task), step: {key: key(1), tool: 'read_file', state: 'failed', purpose: 'tool'}});
  const saved = await store.get(ref(task));
  assert.equal(saved.steps.length, 16);
  assert.equal(saved.steps.find(step => step.key === key(1)).state, 'failed');
  assert.equal(saved.steps.find(step => step.key === key(2)).purpose, 'verification');
  assert.equal(JSON.stringify(saved).includes('不应保存的文件内容'), false);
  assert.equal(JSON.stringify(saved).includes('passed'), false);
  assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.tmp')), false);
});

test('重启后非终态为未知，已结束任务保留原状态', async t => {
  const {store, dir} = await makeStore(t);
  const tasks = [];
  for (const status of TASK_STATES) {
    const task = await store.create({conversationId: '/chat/c/a', goal: status});
    await store.setStatus({...ref(task), status});
    tasks.push({task, status});
  }
  const restarted = new TaskStore({dir, runId: 'run-2'});
  for (const {task, status} of tasks) {
    const saved = await restarted.get(ref(task));
    assert.equal(saved.status, ['completed', 'failed', 'unknown'].includes(status) ? status : 'unknown');
  }
  await assert.rejects(() => restarted.setStatus({...ref(tasks[0].task), status: 'active'}), /不能自动恢复/);
  assert.equal((await restarted.get(ref(tasks[0].task))).status, 'unknown');
});

test('有未结束步骤时不能完成任务；旧记录重启后任务与未结束步骤都显示未知', async t => {
  const {store, dir} = await makeStore(t);
  const task = await store.create({conversationId: '/chat/c/a', goal: '执行并验证'});
  for (const [i, state] of ['requested', 'waiting_approval', 'executing'].entries()) {
    await store.recordStep({...ref(task), step: {key: key(i), state, purpose: 'tool', tool: 'read_file'}});
  }
  await store.recordStep({...ref(task), step: {key: key(3), state: 'completed', purpose: 'verification', tool: 'read_file'}});
  await assert.rejects(() => store.setStatus({...ref(task), status: 'completed'}), /步骤.*未结束/);
  assert.equal((await store.get(ref(task))).status, 'active');

  // 构造旧版错误写入的终态记录，验证恢复不将其当成已完成或已失败。
  for (const oldStatus of ['completed', 'failed']) {
    const file = path.join(dir, `${task.taskId}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.status = oldStatus;
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');
    const restored = await new TaskStore({dir, runId: 'run-2'}).get(ref(task));
    assert.equal(restored.status, 'unknown');
    assert.deepEqual(restored.steps.map(step => step.state), ['unknown', 'unknown', 'unknown', 'completed']);
  }
});

test('任务标记完成后迟到的进行中步骤使状态变为未知，保留步骤以便检查', async t => {
  const {store} = await makeStore(t);
  const task = await store.create({conversationId: '/chat/c/a', goal: '检查文件'});
  await store.setStatus({...ref(task), status: 'completed'});
  const result = await store.recordStep({...ref(task), step: {key: key(1), state: 'executing', purpose: 'tool', tool: 'read_file'}});
  assert.equal(result.status, 'unknown');
  assert.equal(result.steps[0].state, 'executing');
});

test('等待授权被取消后按取消记录，任务可结束且重启后不会变未知', async t => {
  const {store, dir} = await makeStore(t);
  const task = await store.create({conversationId: '/chat/c/a', goal: '操作文件'});
  const step = {key: key(1), purpose: 'tool', tool: 'write_file'};
  await store.recordStep({...ref(task), step: {...step, state: 'waiting_approval'}});
  await store.recordStep({...ref(task), step: {...step, state: 'cancelled'}});
  const finished = await store.setStatus({...ref(task), status: 'completed'});
  assert.equal(finished.steps[0].state, 'cancelled');
  const restored = await new TaskStore({dir, runId: 'run-2'}).get(ref(task));
  assert.equal(restored.status, 'completed');
  assert.equal(restored.steps[0].state, 'cancelled');
});

test('仅允许待建立的新对话迁移，旧对话不能再修改迁移后的任务', async t => {
  const {store} = await makeStore(t);
  const task = await store.create({conversationId: '/chat/', goal: '检查目录'});
  const adopted = await store.adoptConversation({...ref(task), newConversationId: '/chat/c/new'});
  assert.equal(adopted.conversationId, '/chat/c/new');
  assert.equal(await store.get(ref(task)), null);
  await assert.rejects(() => store.setStatus({...ref(task), status: 'completed'}), /没有找到/);
  await assert.rejects(() => store.adoptConversation({taskId: task.taskId, conversationId: '/chat/c/new', newConversationId: '/chat/c/other'}), /不支持/);
  assert.equal((await store.get(ref(task, '/chat/c/new'))).goal, '检查目录');
});

test('限制任务 ID、状态与步骤元数据，拒绝穿越及未知状态', async t => {
  const {store} = await makeStore(t);
  const task = await store.create({conversationId: '/chat/c/a', goal: 'test'});
  await assert.rejects(() => store.get({taskId: '../other', conversationId: task.conversationId}), /任务标识无效/);
  await assert.rejects(() => store.setStatus({...ref(task), status: 'verified'}), /任务状态无效/);
  await assert.rejects(() => store.recordStep({...ref(task), step: {key: '../file', state: 'completed', purpose: 'tool', tool: 'read_file'}}), /任务步骤无效/);
});
