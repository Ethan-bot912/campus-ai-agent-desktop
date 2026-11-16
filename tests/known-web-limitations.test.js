'use strict';

const test = require('node:test');

// 这两项暂不构成自动通过条件：网页缺少可验证的会话或生成完成信号。
// 如需观察当前行为，请在项目根目录运行下方诊断命令；其输出是观察值，不是安全通过结论。
test('同 URL 内切换对话的安全隔离', {skip: '缺少可靠会话标识；诊断：node node_modules/electron/cli.js tests/fixtures/known-web-limitations-electron.js same-url'}, () => {});
test('缺少生成指示时不得提前执行', {skip: '缺少可靠生成完成信号；诊断：node node_modules/electron/cli.js tests/fixtures/known-web-limitations-electron.js no-generating-signal'}, () => {});
