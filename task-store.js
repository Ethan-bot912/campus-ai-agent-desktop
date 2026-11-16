'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TASK_STATES = Object.freeze(['active', 'waiting_model', 'waiting_approval', 'waiting_verification', 'paused', 'completed', 'failed', 'unknown']);
const STEP_STATES = Object.freeze(['requested', 'waiting_approval', 'executing', 'completed', 'failed', 'denied', 'cancelled', 'unknown', 'format_error']);
const TOOLS = new Set(['list_dir', 'read_file', 'write_file', 'delete', 'move', 'run_command', 'open_terminal', 'format_error']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'unknown']);
const UNFINISHED_STEPS = new Set(['requested', 'waiting_approval', 'executing']);
const queues = new Map();

function requireConversation(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 512) throw new Error('对话标识无效。');
}

function requireTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(taskId)) throw new Error('任务标识无效。');
}

// Serialize in-process updates from all TaskStore instances for the same task.
async function serial(key, fn) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

class TaskStore {
  constructor({dir, runId}) {
    this.dir = path.resolve(dir);
    this.runId = runId;
  }

  fileFor(taskId) {
    requireTaskId(taskId);
    return path.join(this.dir, `${taskId}.json`);
  }

  normalize(task) {
    if (task.runId === this.runId) return task;
    const hasUnfinishedStep = task.steps.some(step => UNFINISHED_STEPS.has(step.state));
    if (!hasUnfinishedStep && TERMINAL_STATES.has(task.status)) return task;
    const steps = task.steps.map(step => UNFINISHED_STEPS.has(step.state) ? {...step, state: 'unknown'} : step);
    return {...task, status: 'unknown', steps};
  }

  async write(task) {
    await fs.mkdir(this.dir, {recursive: true});
    const file = this.fileFor(task.taskId);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(task), {encoding: 'utf8', flag: 'wx'});
    await fs.rename(temp, file);
  }

  async create({conversationId, goal}) {
    requireConversation(conversationId);
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 10000) throw new Error('任务目标无效。');
    const now = Date.now();
    const task = {taskId: crypto.randomUUID(), conversationId, goal, status: 'active', runId: this.runId, createdAt: now, updatedAt: now, steps: []};
    await this.write(task);
    return task;
  }

  async get({taskId, conversationId}) {
    requireConversation(conversationId);
    let task;
    try { task = JSON.parse(await fs.readFile(this.fileFor(taskId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (task.conversationId !== conversationId) return null;
    return this.normalize(task);
  }

  async list({conversationId}) {
    requireConversation(conversationId);
    let names;
    try { names = await fs.readdir(this.dir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const tasks = [];
    for (const name of names) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(name)) continue;
      const task = await this.get({taskId: name.slice(0, -5), conversationId});
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  async update({taskId, conversationId}, change) {
    requireConversation(conversationId);
    const file = this.fileFor(taskId);
    return serial(file, async () => {
      const task = await this.get({taskId, conversationId});
      if (!task) throw new Error('当前对话中没有找到该任务。');
      const updated = change(task);
      updated.updatedAt = Date.now();
      updated.runId = this.runId;
      await this.write(updated);
      return updated;
    });
  }

  async setStatus({taskId, conversationId, status}) {
    if (!TASK_STATES.includes(status)) throw new Error('任务状态无效。');
    return this.update({taskId, conversationId}, task => {
      if (task.status === 'unknown' && status !== 'unknown') throw new Error('任务状态未知，不能自动恢复或标记完成。');
      if (status === 'completed' && task.steps.some(step => UNFINISHED_STEPS.has(step.state))) throw new Error('任务步骤尚未结束，不能标记完成。');
      return {...task, status};
    });
  }

  async recordStep({taskId, conversationId, step}) {
    if (!step || typeof step.key !== 'string' || !/^[0-9a-f]{64}$/.test(step.key) || !STEP_STATES.includes(step.state) || !['tool', 'verification'].includes(step.purpose) || !TOOLS.has(step.tool)) throw new Error('任务步骤无效。');
    const {key, state, purpose, tool} = step;
    return this.update({taskId, conversationId}, task => {
      const previous = task.steps.find(item => item.key === key);
      const next = {key, state, purpose, tool, startedAt: previous ? previous.startedAt : Date.now(), updatedAt: Date.now()};
      const steps = previous ? task.steps.map(item => item.key === key ? next : item) : [...task.steps, next];
      const status = task.status === 'completed' && steps.some(item => UNFINISHED_STEPS.has(item.state)) ? 'unknown' : task.status;
      return {...task, status, steps};
    });
  }

  async adoptConversation({taskId, conversationId, newConversationId}) {
    requireConversation(newConversationId);
    if (!/^\/chat\/?(?:\?.*)?$/.test(conversationId) || !/^\/chat\/c\/[^/?]+(?:\?.*)?$/.test(newConversationId)) throw new Error('不支持的对话迁移。');
    return this.update({taskId, conversationId}, task => ({...task, conversationId: newConversationId}));
  }
}

module.exports = {TaskStore, TASK_STATES, STEP_STATES};
