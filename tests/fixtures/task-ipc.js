'use strict';

// Isolated state for older webpage fixtures; no real task or ledger data.
const {randomUUID} = require('node:crypto');

function installTaskIpc(ipcMain) {
  const tasks = new Map();
  ipcMain.handle('agent:taskCreate', (event, {conversationId, goal}) => {
    const task = {taskId: randomUUID(), conversationId, goal, status: 'active', steps: []};
    tasks.set(task.taskId, task);
    return {...task};
  });
  ipcMain.handle('agent:taskList', (event, {conversationId}) => [...tasks.values()].filter(task => task.conversationId === conversationId));
  ipcMain.handle('agent:taskRecover', (event, {conversationId}) => {
    const list = [...tasks.values()].filter(task => task.conversationId === conversationId);
    for (const task of list) if (!['completed', 'failed', 'unknown'].includes(task.status)) task.status = 'unknown';
    return list;
  });
  ipcMain.handle('agent:taskStatus', (event, {taskId, status}) => {
    const task = tasks.get(taskId); task.status = status; return {...task};
  });
  ipcMain.handle('agent:taskStep', (event, {taskId, step}) => {
    const task = tasks.get(taskId); task.steps = [...task.steps.filter(item => item.key !== step.key), step]; return {...task};
  });
  ipcMain.handle('agent:taskAdopt', (event, {taskId, newConversationId}) => {
    const task = tasks.get(taskId); task.conversationId = newConversationId; return {...task};
  });
  ipcMain.handle('agent:taskRecords', () => []);
}

module.exports = {installTaskIpc};
