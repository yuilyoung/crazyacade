mergeInto(LibraryManager.library, {
  PPP_Connect: function (urlPtr, objectPtr, callbackPtr) {
    const url = UTF8ToString(urlPtr), objectName = UTF8ToString(objectPtr), callback = UTF8ToString(callbackPtr);
    if (window.popPopSocket) window.popPopSocket.close();
    window.popPopQueue = [];
    window.popPopSocket = new WebSocket(url);
    window.popPopSocket.onopen = () => { for (const message of window.popPopQueue) window.popPopSocket.send(message); window.popPopQueue = []; };
    window.popPopSocket.onmessage = event => SendMessage(objectName, callback, event.data);
    window.popPopSocket.onerror = () => SendMessage(objectName, callback, '{"type":"error","code":"socket_error"}');
  },
  PPP_Send: function (messagePtr) { const message = UTF8ToString(messagePtr); if (window.popPopSocket && window.popPopSocket.readyState === 1) window.popPopSocket.send(message); else window.popPopQueue.push(message); },
  PPP_Close: function () { if (window.popPopSocket) window.popPopSocket.close(); }
});
