mergeInto(LibraryManager.library, {
  PPP_Connect: function (urlPtr, objectPtr, callbackPtr) {
    const url = UTF8ToString(urlPtr), objectName = UTF8ToString(objectPtr), callback = UTF8ToString(callbackPtr);
    if (window.popPopSocket) {
      window.popPopSocket.onclose = null;
      window.popPopSocket.close();
    }
    window.popPopQueue = [];
    const socket = new WebSocket(url);
    window.popPopSocket = socket;
    socket.onopen = () => {
      if (window.popPopSocket !== socket) return;
      for (const message of window.popPopQueue) socket.send(message);
      window.popPopQueue = [];
    };
    socket.onmessage = event => { if (window.popPopSocket === socket) SendMessage(objectName, callback, event.data); };
    socket.onerror = () => { if (window.popPopSocket === socket) SendMessage(objectName, callback, '{"type":"error","code":"socket_error"}'); };
    socket.onclose = () => {
      if (window.popPopSocket !== socket) return;
      window.popPopQueue = [];
      SendMessage(objectName, callback, '{"type":"error","code":"socket_closed"}');
    };
  },
  PPP_Send: function (messagePtr) {
    const message = UTF8ToString(messagePtr), socket = window.popPopSocket;
    if (socket && socket.readyState === 1) socket.send(message);
    else if (socket && socket.readyState === 0) window.popPopQueue.push(message);
  },
  PPP_Close: function () { if (window.popPopSocket) window.popPopSocket.close(); }
});
