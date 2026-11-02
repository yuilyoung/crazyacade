mergeInto(LibraryManager.library, {
  PPP_AnonymousLogin: function (urlPtr, anonKeyPtr, objectPtr, callbackPtr) {
    const url = UTF8ToString(urlPtr), anonKey = UTF8ToString(anonKeyPtr), objectName = UTF8ToString(objectPtr), callback = UTF8ToString(callbackPtr);
    fetch(`${url}/auth/v1/signup`, { method: 'POST', headers: { 'apikey': anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }) })
      .then(response => response.json()).then(payload => SendMessage(objectName, callback, JSON.stringify(payload)))
      .catch(() => SendMessage(objectName, callback, '{"error":"auth_request_failed"}'));
  }
});
