'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parseToolRequest, validateRequest} = require('../protocol');

const fenced = body => `好的，我先看一下。\n\n\`\`\`json\nPC_TOOL_REQUEST\n${typeof body === 'string' ? body : JSON.stringify(body)}\nPC_TOOL_END\n\`\`\`\n`;

test('合法 list_dir / read_file 请求被解析', () => {
  assert.deepEqual(parseToolRequest(fenced({tool: 'list_dir', path: '.'})).request, {tool: 'list_dir', path: '.'});
  assert.deepEqual(parseToolRequest(fenced({tool: 'read_file', path: 'hello.txt'})).request, {tool: 'read_file', path: 'hello.txt'});
});

test('合法写文件、删除、移动、执行命令、打开终端请求被解析', () => {
  const write = parseToolRequest(fenced({tool: 'write_file', path: 'D:/tmp/a.txt', content: '你好'}));
  assert.equal(write.status, 'ok');
  assert.equal(write.request.content, '你好');

  const del = parseToolRequest(fenced({tool: 'delete', path: 'D:/tmp/a.txt'}));
  assert.deepEqual(del.request, {tool: 'delete', path: 'D:/tmp/a.txt'});

  const move = parseToolRequest(fenced({tool: 'move', from: 'D:/a.txt', to: 'D:/b.txt'}));
  assert.deepEqual(move.request, {tool: 'move', from: 'D:/a.txt', to: 'D:/b.txt'});

  const run = parseToolRequest(fenced({tool: 'run_command', command: 'Get-Date', cwd: 'D:/', timeout_sec: 30}));
  assert.equal(run.status, 'ok');
  assert.equal(run.request.timeout_sec, 30);

  const term = parseToolRequest(fenced({tool: 'open_terminal'}));
  assert.deepEqual(term.request, {tool: 'open_terminal'});
});

test('绝对路径现在被接受（范围由执行层校验）', () => {
  const result = parseToolRequest(fenced({tool: 'read_file', path: 'C:/Windows/win.ini'}));
  assert.equal(result.status, 'ok');
  assert.equal(result.request.path, 'C:/Windows/win.ini');
});

test('普通回复被视为没有工具请求', () => {
  assert.equal(parseToolRequest('这是普通回答，没有工具调用。').status, 'none');
  assert.equal(parseToolRequest('').status, 'none');
});

test('识别模型把工具请求写为 JSON 字段的格式，拒绝含额外字段的请求', () => {
  const reply = '```json\n{"PC_TOOL_REQUEST":{"tool":"run_command","command":"Get-ChildItem D:/"},"PC_TOOL_END":null}\n```';
  const result = parseToolRequest(reply);
  assert.equal(result.status, 'ok');
  assert.equal(result.request.tool, 'run_command');
  assert.equal(parseToolRequest(reply.replace('"PC_TOOL_END":null', '"PC_TOOL_END":null,"other":1')).status, 'invalid');
  assert.equal(parseToolRequest(reply + reply).status, 'invalid');
});

test('网页代码块没有 Markdown 围栏时识别截图中的请求', () => {
  const code = '{"PC_TOOL_REQUEST":{"tool":"list_dir","path":"C:/"},"PC_TOOL_END":null}';
  const text = `看到了！让我再试一次：\n${code}`;
  assert.deepEqual(parseToolRequest(text, [code]), {status: 'ok', request: {tool: 'list_dir', path: 'C:/'}});
  assert.equal(parseToolRequest(text).status, 'invalid');
  assert.equal(parseToolRequest(`${text}\n${code}`, [code, code]).status, 'invalid');
  assert.equal(parseToolRequest(`${text}\nPC_TOOL_REQUEST\n{"tool":"list_dir","path":"D:/"}\nPC_TOOL_END`, [code]).status, 'invalid');
  assert.equal(parseToolRequest(text, [code.replace('null', 'true')]).status, 'invalid');
});

test('缺少结束标记或不完整 JSON 被拒绝', () => {
  const noEnd = parseToolRequest('PC_TOOL_REQUEST\n{"tool":"list_dir","path":"."}');
  assert.equal(noEnd.status, 'invalid');
  assert.match(noEnd.error, /PC_TOOL_END/);
  const broken = parseToolRequest(fenced('{"tool":"read_file","path":"hel'));
  assert.equal(broken.status, 'invalid');
});

test('一次回复里出现多个请求时全部拒绝', () => {
  const text = `${fenced({tool: 'list_dir', path: '.'})}\n${fenced({tool: 'read_file', path: 'hello.txt'})}`;
  const result = parseToolRequest(text);
  assert.equal(result.status, 'invalid');
  assert.match(result.error, /2 个工具请求/);
});

test('未知工具被拒绝', () => {
  for (const tool of ['format_disk', 'eval', 'open_url']) {
    const result = parseToolRequest(fenced({tool, path: 'x'}));
    assert.equal(result.status, 'invalid', `${tool} 应被拒绝`);
    assert.match(result.error, /不支持的工具/);
  }
});

test('缺少必填字段被拒绝', () => {
  assert.match(parseToolRequest(fenced({tool: 'write_file', path: 'a.txt'})).error, /content/);
  assert.match(parseToolRequest(fenced({tool: 'move', from: 'a.txt'})).error, /to/);
  assert.match(parseToolRequest(fenced({tool: 'run_command'})).error, /command/);
  assert.match(parseToolRequest(fenced({tool: 'read_file'})).error, /path/);
  assert.match(parseToolRequest(fenced({tool: 'delete'})).error, /path/);
});

test('多余字段被拒绝', () => {
  assert.match(parseToolRequest(fenced({tool: 'read_file', path: 'a.txt', content: 'x'})).error, /不支持字段/);
  assert.match(parseToolRequest(fenced({tool: 'open_terminal', command: 'dir'})).error, /不支持字段/);
});

test('命令超时被夹到 1..1800 秒', () => {
  assert.equal(parseToolRequest(fenced({tool: 'run_command', command: 'dir', timeout_sec: 99999})).request.timeout_sec, 1800);
  assert.equal(parseToolRequest(fenced({tool: 'run_command', command: 'dir', timeout_sec: 0.4})).request.timeout_sec, 1);
  assert.match(parseToolRequest(fenced({tool: 'run_command', command: 'dir', timeout_sec: 'abc'})).error, /timeout_sec/);
});

test('recursive 必须是布尔值', () => {
  assert.match(parseToolRequest(fenced({tool: 'delete', path: 'D:/x', recursive: 'yes'})).error, /recursive/);
  assert.equal(parseToolRequest(fenced({tool: 'delete', path: 'D:/x', recursive: true})).request.recursive, true);
});

test('JSON 字符串里的标记文本不会提前结束请求', () => {
  const result = parseToolRequest(fenced({tool: 'read_file', path: 'notes/PC_TOOL_END.txt'}));
  assert.equal(result.status, 'ok');
  assert.equal(result.request.path, 'notes/PC_TOOL_END.txt');
});

test('validateRequest 再次校验主进程侧的请求对象', () => {
  assert.equal(validateRequest({tool: 'read_file', path: 'hello.txt'}).ok, true);
  assert.equal(validateRequest({tool: 'write_file', path: 'a.txt', content: ''}).ok, true);
  assert.equal(validateRequest({tool: 'write_file', path: 'a.txt'}).ok, false);
  assert.equal(validateRequest({tool: 'format_disk', path: 'a'}).ok, false);
  assert.equal(validateRequest(null).ok, false);
  assert.equal(validateRequest([]).ok, false);
});
