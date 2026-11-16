'use strict';

function scopeFor(request, {workspace, extraRoots, defaultCwd}) {
  if (request.tool === 'list_dir' || request.tool === 'read_file') {
    return {root: null, defaultCwd: workspace || extraRoots[0] || defaultCwd};
  }
  const roots = [workspace, ...extraRoots].filter(Boolean);
  if (!roots.length) return {root: null, defaultCwd};
  return {roots, defaultCwd: workspace || extraRoots[0]};
}

module.exports = {scopeFor};
