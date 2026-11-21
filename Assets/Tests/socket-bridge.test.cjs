const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeBridge() {
  const messages = [], window = {};
  class Socket {
    constructor(url) { this.url = new URL(url); this.readyState = 0; this.sent = []; }
    send(message) { this.sent.push(message); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = { window, LibraryManager: { library: {} }, mergeInto: Object.assign,
    WebSocket: Socket, UTF8ToString: value => value, SendMessage: (...args) => messages.push(args) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../Plugins/WebGL/PopPopSocket.jslib'), 'utf8'), context);
  return { bridge: context.LibraryManager.library, window, messages };
}

test('disconnect notifies Unity and does not queue stale messages for the next connection', () => {
  const { bridge, window, messages } = makeBridge();
  bridge.PPP_Connect('ws://example', 'client', 'OnSocketMessage');
  const first = window.popPopSocket;
  first.readyState = 1;
  first.onopen();
  first.close();
  assert.equal(JSON.parse(messages.at(-1)[2]).code, 'socket_closed');
  bridge.PPP_Send('stale input');
  bridge.PPP_Connect('ws://example', 'client', 'OnSocketMessage');
  const next = window.popPopSocket;
  next.readyState = 1;
  next.onopen();
  assert.deepEqual(next.sent, []);
});

test('a replaced socket cannot send the new connection queue', () => {
  const { bridge, window } = makeBridge();
  bridge.PPP_Connect('ws://first', 'client', 'OnSocketMessage');
  const first = window.popPopSocket;
  bridge.PPP_Connect('ws://second', 'client', 'OnSocketMessage');
  const next = window.popPopSocket;
  bridge.PPP_Send('join');
  first.onopen();
  assert.deepEqual(first.sent, []);
  next.readyState = 1;
  next.onopen();
  assert.deepEqual(next.sent, ['join']);
});

test('a rejected socket URL reports failure to Unity and a fresh connection can retry', () => {
  const { bridge, window, messages } = makeBridge();
  bridge.PPP_Connect('ws://first', 'client', 'OnSocketMessage');
  const first = window.popPopSocket;
  bridge.PPP_Send('old join');
  assert.doesNotThrow(() => bridge.PPP_Connect('ws://[', 'client', 'OnSocketMessage'));
  bridge.PPP_Send('join after failure');
  first.onmessage({ data: 'stale state' });
  first.onerror();
  assert.deepEqual(messages, [['client', 'OnSocketMessage', '{"type":"error","code":"socket_error"}']]);

  bridge.PPP_Connect('ws://retry', 'client', 'OnSocketMessage');
  bridge.PPP_Send('new join');
  const retry = window.popPopSocket;
  retry.readyState = 1;
  retry.onopen();
  assert.deepEqual(retry.sent, ['new join']);
});
