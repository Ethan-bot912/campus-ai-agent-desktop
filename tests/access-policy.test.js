'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {scopeFor} = require('../access-policy');
const tools = require('../tools');

test('无需工作空间或授权目录即可读取和列出用户指定目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campus-access-read-'));
  await fs.writeFile(path.join(dir, 'hello.txt'), 'hello');
  const config = {workspace: null, extraRoots: [], defaultCwd: dir};
  const listing = await tools.executeTool(scopeFor({tool: 'list_dir'}, config), {tool: 'list_dir', path: dir});
  const file = await tools.executeTool(scopeFor({tool: 'read_file'}, config), {tool: 'read_file', path: path.join(dir, 'hello.txt')});
  assert.ok(listing.entries.some(entry => entry.name === 'hello.txt'));
  assert.equal(file.content, 'hello');
});

test('未选择目录时可在操作授权后使用任意路径；选定目录后限制文件修改范围', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'campus-access-write-'));
  const workspace = path.join(base, 'workspace');
  const extra = path.join(base, 'extra');
  const outside = path.join(base, 'outside.txt');
  await fs.mkdir(workspace);
  await fs.mkdir(extra);
  const request = {tool: 'write_file', path: path.join(workspace, 'test.txt'), content: 'test'};
  const unscoped = scopeFor(request, {workspace: null, extraRoots: [], defaultCwd: base});
  assert.equal(unscoped.root, null);
  await tools.executeTool(unscoped, request);
  assert.equal(await fs.readFile(request.path, 'utf8'), 'test');

  const scope = scopeFor(request, {workspace, extraRoots: [extra], defaultCwd: base});
  await tools.executeTool(scope, request);
  await tools.executeTool(scope, {...request, path: path.join(extra, 'test.txt')});
  await assert.rejects(() => tools.executeTool(scope, {...request, path: outside}), /超出允许范围/);

  const extraOnly = scopeFor(request, {workspace: null, extraRoots: [extra], defaultCwd: base});
  await assert.rejects(() => tools.executeTool(extraOnly, request), /超出允许范围/);
  await tools.executeTool(extraOnly, {...request, path: 'relative.txt'});
  assert.equal(await fs.readFile(path.join(extra, 'relative.txt'), 'utf8'), 'test');
});
