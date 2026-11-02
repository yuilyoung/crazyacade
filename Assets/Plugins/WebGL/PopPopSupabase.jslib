mergeInto(LibraryManager.library, {
  PPP_AnonymousLogin: function (urlPtr, anonKeyPtr, objectPtr, callbackPtr) {
    const url = UTF8ToString(urlPtr), anonKey = UTF8ToString(anonKeyPtr), objectName = UTF8ToString(objectPtr), callback = UTF8ToString(callbackPtr);
    const sessionKey = `popPopSession:${url}`;
    const send = payload => SendMessage(objectName, callback, JSON.stringify(payload));
    let session = null;
    try { session = JSON.parse(window.sessionStorage.getItem(sessionKey)); } catch (_) { /* Storage may be unavailable. */ }
    if (session && session.access_token && session.expires_at > Math.floor(Date.now() / 1000) + 60) {
      send({ access_token: session.access_token, expires_at: session.expires_at });
      return;
    }
    const refreshing = !!(session && session.refresh_token);
    const endpoint = refreshing ? '/auth/v1/token?grant_type=refresh_token' : '/auth/v1/signup';
    const body = refreshing ? { refresh_token: session.refresh_token } : { data: {} };
    fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'apikey': anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok || !payload.access_token || !payload.refresh_token) throw new Error('auth_failed');
        const expiresAt = payload.expires_at || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 0);
        try { window.sessionStorage.setItem(sessionKey, JSON.stringify({ access_token: payload.access_token, refresh_token: payload.refresh_token, expires_at: expiresAt })); } catch (_) { /* Login still works if browser storage is unavailable. */ }
        send({ access_token: payload.access_token, expires_at: expiresAt });
      })
      .catch(() => send({ error: 'auth_request_failed' }));
  }
});
