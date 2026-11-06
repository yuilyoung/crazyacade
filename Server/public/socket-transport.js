/** Browser socket adapter: construction, JSON framing and event ownership live here. */
export function createSocketTransport({ url, WebSocketClass = globalThis.WebSocket } = {}) {
  return {
    connect(payload, { onMessage = () => {}, onClose = () => {}, onError = () => {} } = {}) {
      const socket = new WebSocketClass(url);
      let closed = false;
      const port = {
        get readyState() { return socket.readyState; },
        send(value) { if (closed || socket.readyState !== 1) return false; socket.send(typeof value === 'string' ? value : JSON.stringify(value)); return true; },
        close() { if (closed) return; closed=true; for (const [type, callback] of Object.entries(events)) socket.removeEventListener(type, callback); socket.close(); }
      };
      const events = {
        open: () => port.send(payload),
        message: event => { let value; try { value=JSON.parse(event.data); } catch { return; } if (value && typeof value === 'object') onMessage(value, port); },
        close: event => onClose(event, port), error: event => onError(event, port)
      };
      for (const [type, callback] of Object.entries(events)) socket.addEventListener(type, callback);
      return port;
    }
  };
}
