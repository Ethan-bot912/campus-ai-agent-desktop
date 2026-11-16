'use strict';

// 解析模型输出中的单个文本工具请求。纯函数，不接触 DOM 与文件系统。

const START = 'PC_TOOL_REQUEST';
const END = 'PC_TOOL_END';
const TOOL_NAMES = Object.freeze(['list_dir', 'read_file', 'write_file', 'delete', 'move', 'run_command', 'open_terminal']);
const MUTATING_TOOLS = Object.freeze(['write_file', 'delete', 'move', 'run_command', 'open_terminal']);
const MAX_REPLY_CHARS = 400 * 1024;

const FIELDS = {
  list_dir: ['path'],
  read_file: ['path'],
  write_file: ['path', 'content'],
  delete: ['path', 'recursive'],
  move: ['from', 'to'],
  run_command: ['command', 'cwd', 'timeout_sec'],
  open_terminal: []
};

const REQUIRED = {
  list_dir: ['path'],
  read_file: ['path'],
  write_file: ['path', 'content'],
  delete: ['path'],
  move: ['from', 'to'],
  run_command: ['command'],
  open_terminal: []
};

// 在 JSON 字符串之外查找标记，避免字符串内容里的同名文本被当成标记。
function findMarkers(text) {
  const markers = [];
  let inside = false;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inside && quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (inside && ch === '"') {
      quoted = true;
      continue;
    }
    if (text.startsWith(START, i) && /^\s*\{/.test(text.slice(i + START.length, i + START.length + 32))) {
      markers.push({start: i, end: -1});
      inside = true;
      quoted = false;
      escaped = false;
      i += START.length - 1;
      continue;
    }
    if (inside && text.startsWith(END, i)) {
      markers[markers.length - 1].end = i;
      inside = false;
      quoted = false;
      escaped = false;
      i += END.length - 1;
    }
  }
  return markers;
}

function diagnoseJson(raw, error) {
  if (/[\u201c\u201d]/.test(raw)) return 'JSON 使用了中文引号，请改成英文双引号。';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (!quoted) {
      if (ch === '"') quoted = true;
      continue;
    }
    if (ch === '"') {
      quoted = false;
      continue;
    }
    if (ch.charCodeAt(0) < 32) return 'JSON 字符串中有直接换行或控制字符，请写成转义后的 \\n。';
    if (ch === '\\') {
      const next = raw[i + 1];
      if (!next || !'"\\/bfnrtu'.includes(next)) return 'JSON 中有无效的反斜杠转义；路径请使用正斜杠，或把反斜杠写成 \\\\。';
      if (next === 'u' && !/^[0-9a-f]{4}$/i.test(raw.slice(i + 2, i + 6))) return 'JSON 中的 \\u 转义不完整。';
      i += next === 'u' ? 5 : 1;
    }
  }
  if (/unterminated|Unexpected end/i.test(error.message)) return 'JSON 字符串没有正确结束，请检查引号和末尾。';
  return `JSON 无法解析：${error.message}。请检查引号和逗号。`;
}

function validatePath(value, field = 'path') {
  if (typeof value !== 'string' || !value.trim()) return {ok: false, error: `缺少 ${field} 字符串。`};
  if (value.includes('\0')) return {ok: false, error: `${field} 包含非法字符。`};
  return {ok: true, path: value};
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok: false, error: '请求必须是 JSON 对象。'};
  if (!TOOL_NAMES.includes(value.tool)) {
    return {ok: false, error: `不支持的工具：${String(value.tool)}；只允许 ${TOOL_NAMES.join('、')}。`};
  }
  const allowed = FIELDS[value.tool];
  for (const key of Object.keys(value)) {
    if (key !== 'tool' && !allowed.includes(key)) return {ok: false, error: `${value.tool} 不支持字段：${key}。`};
  }
  for (const field of REQUIRED[value.tool]) {
    if (!(field in value)) return {ok: false, error: `${value.tool} 缺少 ${field}。`};
  }

  const request = {tool: value.tool};
  if (value.tool === 'move') {
    const from = validatePath(value.from, 'from');
    if (!from.ok) return from;
    const to = validatePath(value.to, 'to');
    if (!to.ok) return to;
    return {ok: true, request: {tool: 'move', from: from.path, to: to.path}};
  }
  if (value.tool === 'run_command') {
    if (typeof value.command !== 'string' || !value.command.trim()) return {ok: false, error: 'command 必须是非空字符串。'};
    if (value.cwd !== undefined) {
      const cwd = validatePath(value.cwd, 'cwd');
      if (!cwd.ok) return cwd;
      request.cwd = cwd.path;
    }
    if (value.timeout_sec !== undefined) {
      const timeout = Number(value.timeout_sec);
      if (!Number.isFinite(timeout) || timeout <= 0) return {ok: false, error: 'timeout_sec 必须是正数。'};
      request.timeout_sec = Math.min(Math.max(Math.round(timeout), 1), 1800);
    }
    return {ok: true, request: {...request, command: value.command}};
  }
  if (value.tool === 'open_terminal') return {ok: true, request: {tool: 'open_terminal'}};
  if (value.tool === 'write_file') {
    if (typeof value.content !== 'string') return {ok: false, error: 'write_file 的 content 必须是字符串。'};
    const pathCheck = validatePath(value.path);
    if (!pathCheck.ok) return pathCheck;
    return {ok: true, request: {tool: 'write_file', path: pathCheck.path, content: value.content}};
  }
  if (value.tool === 'delete') {
    if (value.recursive !== undefined && typeof value.recursive !== 'boolean') return {ok: false, error: 'recursive 必须是 true 或 false。'};
    const pathCheck = validatePath(value.path);
    if (!pathCheck.ok) return pathCheck;
    return {ok: true, request: {tool: 'delete', path: pathCheck.path, ...(value.recursive ? {recursive: true} : {})}};
  }
  const pathCheck = validatePath(value.path);
  if (!pathCheck.ok) return pathCheck;
  return {ok: true, request: {tool: value.tool, path: pathCheck.path}};
}

// 返回 {status:'none'} | {status:'invalid', error} | {status:'ok', request}
function parseToolRequest(text, codeBlocks = []) {
  if (typeof text !== 'string' || !text.trim()) return {status: 'none'};
  if (text.length > MAX_REPLY_CHARS) return {status: 'invalid', error: '回复文本超过 400 KB，未解析。'};
  const markers = findMarkers(text);
  const envelopeCount = (text.match(/"PC_TOOL_REQUEST"\s*:/g) || []).length;
  if (markers.length && envelopeCount) return {status: 'invalid', error: '本次回复包含多个或混合格式的工具请求，未执行。'};
  if (markers.length === 0) {
    if (/"PC_TOOL_REQUEST"\s*:/.test(text)) {
      const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
      const candidates = blocks.length ? blocks.map(block => block[1]) : codeBlocks.filter(block => /"PC_TOOL_REQUEST"\s*:/.test(block));
      if (candidates.length !== 1 || envelopeCount !== 1) return {status: 'invalid', error: '工具请求格式不明确，未执行。'};
      try {
        const envelope = JSON.parse(candidates[0]);
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, START) || envelope[END] !== null || (text.match(/"PC_TOOL_REQUEST"\s*:/g) || []).length !== 1) return {status: 'invalid', error: '工具请求格式不明确，未执行。'};
        const check = validateRequest(envelope[START]);
        return check.ok ? {status: 'ok', request: check.request} : {status: 'invalid', error: check.error};
      } catch {
        return {status: 'invalid', error: '工具请求 JSON 不完整或格式错误，未执行。'};
      }
    }
    return {status: 'none'};
  }
  if (markers.length > 1) {
    return {status: 'invalid', error: `本次回复包含 ${markers.length} 个工具请求，全部未执行；每次只允许一个请求。`};
  }
  const marker = markers[0];
  if (marker.end < 0) return {status: 'invalid', error: '工具请求不完整：JSON 未正确结束，或缺少 PC_TOOL_END。'};
  const raw = text.slice(marker.start + START.length, marker.end).trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {status: 'invalid', error: diagnoseJson(raw, error)};
  }
  const check = validateRequest(parsed);
  if (!check.ok) return {status: 'invalid', error: check.error};
  return {status: 'ok', request: check.request};
}

module.exports = {
  START,
  END,
  TOOL_NAMES,
  MUTATING_TOOLS,
  MAX_REPLY_CHARS,
  FIELDS,
  findMarkers,
  validateRequest,
  parseToolRequest
};
