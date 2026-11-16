'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {resultText} = require('./result-format');

const DELIVERIES = Object.freeze(['not_sent', 'sending', 'submitted', 'unknown']);
const MAX_RESULT_CHARS = 300 * 1024;
const MAX_LIST = 50;

function clampText(value) {
  if (typeof value !== 'string') return null;
  return value.length > MAX_RESULT_CHARS ? value.slice(0, MAX_RESULT_CHARS) : value;
}

// 每次候选工具请求在本地有一条记录；键由对话与消息内容派生，重复命中不会再次执行。
class Ledger {
  constructor({dir, runId}) {
    this.dir = dir;
    this.runId = runId;
  }

  idFor(key) {
    return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
  }

  fileFor(key) {
    return path.join(this.dir, `${this.idFor(key)}.json`);
  }

  async init() {
    await fs.mkdir(this.dir, {recursive: true});
  }

  // 状态为 executing 且来自上一次运行的记录，说明上次未确认结束。
  normalize(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    if ((entry.state === 'executing' || entry.state === 'running') && entry.runId !== this.runId) {
      return {...entry, state: 'unknown', error: '上次运行未确认该操作是否结束；不会自动重跑。'};
    }
    return entry;
  }

  async begin({key, conversationId, replyIndex, request}) {
    await this.init();
    const entry = {
      id: this.idFor(key),
      key,
      conversationId,
      replyIndex,
      request,
      state: 'executing',
      runId: this.runId,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      resultText: null,
      delivery: null,
      deliveryAt: null,
      error: null
    };
    try {
      await fs.writeFile(this.fileFor(key), JSON.stringify(entry), {encoding: 'utf8', flag: 'wx'});
      return {status: 'created', entry};
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.read(key);
      return {status: 'exists', entry: existing || {...entry, state: 'unknown', error: '已有本地记录无法读取。'}};
    }
  }

  async recordFormatError({key, conversationId, replyIndex, error, stop}) {
    await this.init();
    const result = {ok: false, kind: 'format_error', message: '工具请求格式错误，没有执行。', error, instruction: '请重写工具请求，使用合法 JSON；不要假定本地操作已执行。'};
    const now = Date.now();
    const entry = {
      id: this.idFor(key), key, conversationId, replyIndex, kind: 'format_error', request: null,
      state: 'format_error', runId: this.runId, startedAt: now, finishedAt: now,
      result, resultText: stop ? null : resultText(result), delivery: stop ? null : 'not_sent', deliveryAt: null, error
    };
    try {
      await fs.writeFile(this.fileFor(key), JSON.stringify(entry), {encoding: 'utf8', flag: 'wx'});
      return {status: 'created', entry};
    } catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      return {status: 'exists', entry: await this.read(key)};
    }
  }

  async read(key) {
    let raw;
    try {
      raw = await fs.readFile(this.fileFor(key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return {key, state: 'unknown', error: `本地记录无法读取：${error.message}`, resultText: null, delivery: null};
    }
    try {
      return this.normalize(JSON.parse(raw));
    } catch (error) {
      return {key, state: 'unknown', error: `本地记录已损坏：${error.message}`, resultText: null, delivery: null};
    }
  }

  async write(entry) {
    await this.init();
    const file = this.fileFor(entry.key);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(entry), 'utf8');
    await fs.rename(temp, file);
    return entry;
  }

  async recordResult({key, state, result, resultText}) {
    const entry = await this.read(key);
    if (!entry) throw new Error('没有找到本地执行记录。');
    const updated = {
      ...entry,
      state,
      result,
      resultText: clampText(resultText),
      finishedAt: Date.now(),
      error: state === 'failed' ? (result && result.error) || '执行失败。' : null
    };
    return this.write(updated);
  }

  async markDelivery({key, delivery}) {
    if (!DELIVERIES.includes(delivery)) throw new Error(`不支持的发送状态：${delivery}`);
    const entry = await this.read(key);
    if (!entry) throw new Error('没有找到本地执行记录。');
    return this.write({...entry, delivery, deliveryAt: Date.now()});
  }

  async list(conversationId) {
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const name of names.filter(item => item.endsWith('.json'))) {
      try {
        const entry = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
        if (typeof conversationId === 'string' && entry.conversationId !== conversationId) continue;
        entries.push(this.normalize(entry));
      } catch {
        // 损坏的记录不猜测其状态，直接跳过。
      }
    }
    entries.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return entries.slice(0, MAX_LIST);
  }
}

module.exports = {DELIVERIES, MAX_RESULT_CHARS, Ledger};
