'use strict';

function isCurrentTask(expected, current, replyText) {
  return current.armed && !current.paused && expected.generation === current.generation &&
    expected.conversationId === current.conversationId && expected.scopeVersion === current.scopeVersion && current.replyText === replyText;
}

module.exports = {isCurrentTask};
