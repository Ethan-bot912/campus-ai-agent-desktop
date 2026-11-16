'use strict';

// 进度是模型自述，不参与工具解析、授权或验证。
const PROGRESS_BEGIN = 'CAMPUS_AGENT_PROGRESS';
const PROGRESS_END = 'CAMPUS_AGENT_PROGRESS_END';
const MAX_REPLY_CHARS = 400 * 1024;
const MAX_BLOCK_CHARS = 8 * 1024;
const MAX_ITEM_CHARS = 2000;
const MAX_ITEMS = 20;
const PROGRESS_FIELDS = new Set(['goal', 'next', 'blockers']);
const FILE_OPERATIONS = Object.freeze({list_dir: '查看目录', read_file: '读取', write_file: '写入', delete: '删除', move: '移动'});

function trackFailure(previous, request, entry) {
  if (entry.state === 'completed' && entry.result?.ok === true) return null;
  if (entry.state !== 'failed') return previous;
  const operation = JSON.stringify(Object.fromEntries(Object.keys(request).sort().map(key => [key, request[key]])));
  const result = entry.result || {};
  const error = typeof result.code === 'string' && result.code ? `code:${result.code}`
    : Number.isInteger(result.exitCode) && result.exitCode !== 0 ? `exit:${result.exitCode}`
      : result.timedOut === true ? 'timeout'
        : typeof result.error === 'string' && result.error ? `error:${result.error}` : null;
  return {operation, error, operationCount: previous?.operation === operation ? previous.operationCount + 1 : 1,
    errorCount: error && previous?.error === error ? previous.errorCount + 1 : 1};
}

function parseModelProgress(text) {
  if (typeof text !== 'string') throw new TypeError('模型回复必须是文本。');
  if (!text.includes(PROGRESS_BEGIN) && !text.includes(PROGRESS_END)) return {status: 'none'};
  if (text.length > MAX_REPLY_CHARS) return {status: 'invalid', error: '模型回复过长，未解析模型计划。'};
  const lines = text.split(/\r?\n/);
  const starts = [], ends = [];
  lines.forEach((line, index) => {
    if (line.trim() === PROGRESS_BEGIN) starts.push(index);
    if (line.trim() === PROGRESS_END) ends.push(index);
  });
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0] || text.includes('PC_TOOL_REQUEST') || text.includes('PC_TOOL_END')) {
    return {status: 'invalid', error: '模型计划格式不明确，未解析。'};
  }
  const raw = lines.slice(starts[0] + 1, ends[0]).join('\n');
  if (raw.length > MAX_BLOCK_CHARS) return {status: 'invalid', error: '模型计划过长，未解析。'};
  let report;
  try { report = JSON.parse(raw); }
  catch { return {status: 'invalid', error: '模型计划不是合法 JSON，未解析。'}; }
  const validText = value => typeof value === 'string' && value.length <= MAX_ITEM_CHARS;
  const validValue = value => validText(value) || (Array.isArray(value) && value.length <= MAX_ITEMS && value.every(validText));
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Object.keys(report).length || Object.keys(report).some(key => !PROGRESS_FIELDS.has(key) || !validValue(report[key]))) {
    return {status: 'invalid', error: '模型计划字段无效，未解析。'};
  }
  return {status: 'ok', report};
}

// 调用方只传当前任务已关联的本机记录。本函数不访问文件或账本。
function summarizeLocalEvidence(entries) {
  if (!Array.isArray(entries)) throw new TypeError('本机记录必须是数组。');
  const files = [], commands = [], checks = [];
  for (const entry of entries) {
    if (!entry || !entry.request || !entry.result) continue;
    const {request, result} = entry;
    if (request.tool !== result.tool) continue;
    if (request.tool === 'run_command' && ['completed', 'failed'].includes(entry.state)) {
      commands.push({
        key: entry.key,
        state: entry.state,
        exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
        timedOut: typeof result.timedOut === 'boolean' ? result.timedOut : null,
        cancelled: typeof result.cancelled === 'boolean' ? result.cancelled : null,
        truncated: typeof result.truncated === 'boolean' ? result.truncated : null,
        stderrHasOutput: typeof result.stderr === 'string' ? result.stderr.length > 0 : null
      });
      continue;
    }
    const operation = Object.hasOwn(FILE_OPERATIONS, request.tool) ? FILE_OPERATIONS[request.tool] : null;
    if (!operation || entry.state !== 'completed' || result.ok !== true) continue;
    if (request.tool === 'move') {
      if (typeof result.from === 'string' && result.from && typeof result.to === 'string' && result.to) {
        files.push({key: entry.key, operation, from: result.from, to: result.to});
      }
    } else if (typeof result.path === 'string' && result.path) {
      files.push({key: entry.key, operation, path: result.path});
      if (request.tool === 'write_file') checks.push({writeKey: entry.key, path: result.path, status: 'unavailable'});
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const read = entries[i];
    if (read?.state !== 'completed' || read.request?.tool !== 'read_file' || read.result?.tool !== 'read_file' || read.result.ok !== true || typeof read.result.path !== 'string' || typeof read.result.content !== 'string' || !Number.isInteger(read.result.bytes) || !Number.isFinite(read.startedAt)) continue;
    const write = entries.slice(0, i).reverse().find(entry => entry?.state === 'completed' && entry.request?.tool === 'write_file' && entry.result?.tool === 'write_file' && entry.result.ok === true && entry.result.path === read.result.path && Number.isFinite(entry.finishedAt) && entry.finishedAt < read.startedAt);
    if (!write || typeof write.request.content !== 'string' || !Number.isInteger(write.result.bytes)) continue;
    const expected = Buffer.from(write.request.content, 'utf8');
    const decoded = Buffer.from(read.result.content, 'utf8');
    if (expected.length !== write.result.bytes) continue;
    let actual;
    if (decoded.length === read.result.bytes) actual = decoded;
    else if (decoded.length + 3 === read.result.bytes) actual = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), decoded]);
    else continue;
    const check = checks.find(item => item.writeKey === write.key);
    if (check) Object.assign(check, {readKey: read.key, status: expected.equals(actual) ? 'match' : 'mismatch'});
  }
  return {files, commands, verification: {status: 'unverified', message: '未验证', checks}};
}

module.exports = {PROGRESS_BEGIN, PROGRESS_END, parseModelProgress, summarizeLocalEvidence, trackFailure};
