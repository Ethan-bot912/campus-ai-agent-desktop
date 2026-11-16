'use strict';

// 加载实际 IPC 处理器；所有可能访问真实环境的依赖均为失败即暴露的替身。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.join(__dirname, '..');
const handlers = new Map();
const listeners = new Map();
const touched = [];
const forbidden = name => (...args) => {
  touched.push(name);
  throw new Error(`测试中不应访问真实环境：${name}`);
};
class FakeLedger {
  constructor() {}
  begin = forbidden('ledger.begin');
  read = forbidden('ledger.read');
  recordResult = forbidden('ledger.recordResult');
  recordFormatError = forbidden('ledger.recordFormatError');
  markDelivery = forbidden('ledger.markDelivery');
  list = forbidden('ledger.list');
}
class FakeTaskStore {
  constructor() {}
  create = forbidden('task.create');
  get = forbidden('task.get');
  list = forbidden('task.list');
  setStatus = forbidden('task.setStatus');
  recordStep = forbidden('task.recordStep');
  adoptConversation = forbidden('task.adoptConversation');
}
const electron = {
  app: {setPath() {}, requestSingleInstanceLock: () => false, quit() {}, on() {}},
  ipcMain: {handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler)},
  BrowserWindow: {}, session: {}, shell: {}, dialog: {showOpenDialog: forbidden('dialog')}
};
const tools = {
  ToolError: class ToolError extends Error {},
  resolvePath: forbidden('tools.resolvePath'),
  readFile: forbidden('tools.readFile'),
  executeTool: forbidden('tools.executeTool')
};
const fakeRequire = name => {
  if (name === 'electron') return electron;
  if (name === './tools') return tools;
  if (name === './ledger') return {Ledger: FakeLedger};
  if (name === './task-store') return {TaskStore: FakeTaskStore};
  if (name === 'node:fs/promises') return new Proxy({}, {get: (_, key) => forbidden(`fs.${String(key)}`)});
  if (name.startsWith('./')) return require(path.join(project, name));
  return require(name);
};
const source = fs.readFileSync(path.join(project, 'main.js'), 'utf8');
vm.runInThisContext(`(function(require, __dirname, module, exports) {${source}\n})`, {filename: 'main.js'})(fakeRequire, project, {exports: {}}, {});

const identity = {key: 'a'.repeat(64), conversationId: '/chat/c/test', replyIndex: 0, taskId: '00000000-0000-4000-8000-000000000001'};
const payloads = {
  'agent:info': undefined,
  'agent:chooseDirectory': 'workspace',
  'agent:clearExtra': undefined,
  'agent:clearWorkspace': undefined,
  'agent:previewWrite': {tool: 'write_file', path: 'C:/fixture.txt', content: 'fixture'},
  'agent:taskCreate': {...identity, goal: 'fixture'},
  'agent:taskList': identity,
  'agent:taskRecover': identity,
  'agent:taskStatus': {...identity, status: 'active'},
  'agent:taskStep': {...identity, step: {key: identity.key, state: 'requested', purpose: 'tool', tool: 'read_file'}},
  'agent:taskAdopt': {...identity, conversationId: '/chat/', newConversationId: '/chat/c/test'},
  'agent:taskRecords': identity,
  'agent:execute': {...identity, scopeVersion: 0, request: {tool: 'read_file', path: 'C:/fixture.txt'}},
  'agent:deny': {...identity, request: {tool: 'write_file', path: 'C:/fixture.txt', content: 'fixture'}},
  'agent:formatError': {...identity, error: 'fixture', stop: false},
  'agent:injectStatus': undefined,
  'agent:cancel': undefined,
  'agent:markDelivery': {key: identity.key, delivery: 'submitted'},
  'agent:list': identity
};
const blockedUrls = [
  'https://ai.cuhk.edu.cn/login',
  'https://other.example/chat/',
  'https://ai.cuhk.edu.cn.evil.example/chat/',
  'http://ai.cuhk.edu.cn/chat/',
  'https://ai.cuhk.edu.cn/chatty',
  'file:///chat/index.html'
];
const sender = url => ({senderFrame: url === null ? null : {url}, sender: {executeJavaScript: forbidden('sender.executeJavaScript')}});

test('非学校聊天页面不能调用主进程的本地能力 IPC', async () => {
  assert.deepEqual([...handlers.keys()].sort(), Object.keys(payloads).sort(), '新增 IPC 必须补充来源校验测试');
  for (const url of [...blockedUrls, null]) {
    for (const [name, handler] of handlers) {
      await assert.rejects(Promise.resolve().then(() => handler(sender(url), payloads[name])), /不允许|无效/, `${name} 意外接受来源 ${url}`);
    }
    assert.deepEqual(touched, [], `来源 ${url} 触及受保护依赖`);
  }
});

test('学校聊天页仍可访问受限信息接口', () => {
  const result = handlers.get('agent:info')(sender('https://ai.cuhk.edu.cn/chat/c/test'));
  assert.equal(result.workspace, null);
  assert.deepEqual(result.extraRoots, []);
  assert.deepEqual(touched, []);
});

test('只有学校聊天页可通过 invalidate 取消正在准备的执行', async () => {
  async function runWithInvalidation(url) {
    const localHandlers = new Map(), localListeners = new Map(), steps = [];
    let releaseRequested, reachedRequested;
    const requested = new Promise(resolve => { reachedRequested = resolve; });
    let executeCount = 0;
    class Store {
      constructor() {}
      async recordStep({step}) {
        steps.push(step.state);
        if (step.state === 'requested') {
          reachedRequested();
          await new Promise(resolve => { releaseRequested = resolve; });
        }
      }
      async get() { return {status: 'active'}; }
    }
    class LocalLedger {
      constructor() {}
      async begin() { return {status: 'created'}; }
      async recordResult({state, result}) { return {state, result}; }
    }
    const localTools = {
      ToolError: class ToolError extends Error {},
      async executeTool() { executeCount++; return {ok: true, tool: 'read_file', content: 'fixture'}; }
    };
    const localElectron = {
      app: {setPath() {}, requestSingleInstanceLock: () => false, quit() {}, on() {}},
      ipcMain: {handle: (name, handler) => localHandlers.set(name, handler), on: (name, handler) => localListeners.set(name, handler)},
      BrowserWindow: {}, session: {}, shell: {}, dialog: {}
    };
    const localRequire = name => {
      if (name === 'electron') return localElectron;
      if (name === './tools') return localTools;
      if (name === './ledger') return {Ledger: LocalLedger};
      if (name === './task-store') return {TaskStore: Store};
      if (name === 'node:fs/promises') return new Proxy({}, {get: (_, key) => forbidden(`fs.${String(key)}`)});
      if (name.startsWith('./')) return require(path.join(project, name));
      return require(name);
    };
    vm.runInThisContext(`(function(require, __dirname, module, exports) {${source}\n})`, {filename: 'main.js'})(localRequire, project, {exports: {}}, {});
    const operation = Promise.resolve().then(() => localHandlers.get('agent:execute')(
      sender('https://ai.cuhk.edu.cn/chat/c/test'), payloads['agent:execute']
    )).then(value => ({value}), error => ({error}));
    await requested;
    localListeners.get('agent:invalidate')(sender(url));
    releaseRequested();
    const result = await operation;
    return {result, executeCount, steps};
  }

  const external = await runWithInvalidation('https://other.example/chat/');
  assert.equal(external.result.value.status, 'created');
  assert.equal(external.executeCount, 1);
  assert.deepEqual(external.steps, ['requested', 'executing', 'completed']);

  const chat = await runWithInvalidation('https://ai.cuhk.edu.cn/chat/c/test');
  assert.match(chat.result.error.message, /未执行/);
  assert.equal(chat.executeCount, 0);
  assert.deepEqual(chat.steps, ['requested', 'cancelled']);
});
