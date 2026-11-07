import { accountError } from './account-service.js';
import { StringDecoder } from 'node:string_decoder';

function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return Promise.reject(accountError('invalid_request', 400));
  if (Number(req.headers['content-length']) > 4096) { req.resume(); return Promise.reject(accountError('request_too_large', 413)); }
  return new Promise((resolve, reject) => {
    let size = 0, body = '';
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => finish(accountError('request_timeout', 408)), 5000);
    const finish = (error, value) => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed); if (error) { req.resume(); reject(error); } else resolve(value); };
    const data = chunk => { size += chunk.length; if (size > 4096) finish(accountError('request_too_large', 413)); else body += decoder.write(chunk); };
    const failed = () => finish(accountError('invalid_request', 400));
    const end = () => { try { const input = JSON.parse(body + decoder.end()); if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error(); finish(null, input); } catch { finish(accountError('invalid_request', 400)); } };
    req.on('data', data); req.on('end', end); req.on('error', failed); req.on('aborted', failed);
  });
}

export async function handleAccountRequest(req, res, pathname, service, respond) {
  if (pathname !== '/api/account' && pathname !== '/api/account/profile') return false;
  const allowed = pathname === '/api/account' ? ['GET', 'HEAD'] : ['PATCH'];
  if (!allowed.includes(req.method)) { res.setHeader('Allow', allowed.join(', ')); respond(405, JSON.stringify({ error: 'method_not_allowed' }), 'application/json; charset=utf-8'); return true; }
  try {
    const token = /^Bearer ([^\s]{1,8192})$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw accountError('unauthorized', 401);
    const body = pathname === '/api/account' ? await service.getAccount(token) : await service.updateProfile(token, await readJson(req));
    respond(200, JSON.stringify(body), 'application/json; charset=utf-8');
  } catch (error) {
    const known = ['unauthorized', 'account_not_configured', 'account_unavailable', 'invalid_nickname', 'invalid_request', 'request_too_large', 'request_timeout'].includes(error.code);
    respond(known ? error.status : 503, JSON.stringify({ error: known ? error.code : 'account_unavailable' }), 'application/json; charset=utf-8');
  }
  return true;
}
