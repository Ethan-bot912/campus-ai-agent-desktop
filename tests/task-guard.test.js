'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isCurrentTask} = require('../task-guard');

test('暂停、切换对话、重新开启、切换目录和回复变化使旧授权失效', () => {
  const expected = {generation: 1, conversationId: '/chat/a', scopeVersion: 2};
  const current = {generation: 1, conversationId: '/chat/a', scopeVersion: 2, armed: true, paused: false, replyText: '请求'};
  assert.equal(isCurrentTask(expected, current, '请求'), true);
  for (const change of [{paused: true}, {armed: false}, {conversationId: '/chat/b'}, {generation: 2}, {scopeVersion: 3}, {replyText: '新请求'}]) {
    assert.equal(isCurrentTask(expected, {...current, ...change}, '请求'), false);
  }
});
