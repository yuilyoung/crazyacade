const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('disconnect notifies Unity and does not queue stale messages for the next connection', () => {
  const messages = [];
  class Socket {
    constructor() { this.readyState = 0; this.sent = []; }
    send(message) { this.sent.push(message); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const context = { window: {}, LibraryManager: {library:{}}, mergeInto: Object.assign, WebSocket: Socket, UTF8ToString: x => x, SendMessage: (...args) => messages.push(args) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../Plugins/WebGL/PopPopSocket.jslib'), 'utf8'), context);
  const bridge = context.LibraryManager.library;
  bridge.PPP_Connect('ws://example', 'client', 'OnSocketMessage');
  const first = context.window.popPopSocket;
  first.readyState = 1;
  first.onopen();
  first.close();
  assert.equal(JSON.parse(messages.at(-1)[2]).code, 'socket_closed');
  bridge.PPP_Send('stale input');
  bridge.PPP_Connect('ws://example', 'client', 'OnSocketMessage');
  const next = context.window.popPopSocket;
  next.readyState = 1;
  next.onopen();
  assert.deepEqual(next.sent, []);
});

test('a replaced socket cannot send the new connection queue', () => {
  class Socket {
    constructor() { this.readyState = 0; this.sent = []; }
    send(message) { this.sent.push(message); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  const context = { window: {}, LibraryManager: {library:{}}, mergeInto: Object.assign, WebSocket: Socket, UTF8ToString: x => x, SendMessage: () => {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../Plugins/WebGL/PopPopSocket.jslib'), 'utf8'), context);
  const bridge = context.LibraryManager.library;
  bridge.PPP_Connect('ws://first', 'client', 'OnSocketMessage');
  const first = context.window.popPopSocket;
  bridge.PPP_Connect('ws://second', 'client', 'OnSocketMessage');
  const next = context.window.popPopSocket;
  bridge.PPP_Send('join');
  first.onopen();
  assert.deepEqual(first.sent, []);
  next.readyState = 1;
  next.onopen();
  assert.deepEqual(next.sent, ['join']);
});
