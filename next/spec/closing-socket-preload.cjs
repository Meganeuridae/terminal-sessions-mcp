'use strict';

// Only the CLI child loads this. Move its client socket to CLOSING just before
// the tools/list reply reaches tsm, so its next tools/call tests ws.send's real closing-state path.
const WebSocket = require('ws');
const emit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (event, ...args) {
  if (event === 'message' && this.readyState === WebSocket.OPEN) {
    let message;
    try { message = JSON.parse(args[0].toString()); } catch { /* not a tools/list result */ }
    if (Array.isArray(message?.result?.tools)) this.close(1000);
  }
  return emit.call(this, event, ...args);
};
