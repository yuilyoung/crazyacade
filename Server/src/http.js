import { getLeaderboard } from './rankings.js';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPublicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2'
};
const runtimeFields = [
  'connections', 'maxConnections', 'rooms', 'maxRooms', 'queuedPlayers', 'maxQueuedPlayers',
  'authActive', 'authPending', 'authRejected', 'authCapacity', 'authMaxPending', 'connectionsRejected',
  'messagesAccepted', 'messagesRejected', 'rateLimitedSockets', 'slowSockets', 'stateSkipped', 'sendErrors',
  'ticks', 'tickDurationMs', 'tickMaxDurationMs', 'tickLagMs', 'tickMaxLagMs', 'rssBytes', 'uptimeSeconds'
];

export function createRequestHandler({ publicRoot = defaultPublicRoot, env = process.env, storageDiagnostics, runtimeDiagnostics } = {}) {
  const root = path.resolve(publicRoot);
  return async (req, res) => {
    const respond = (status, body, contentType = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD'); respond(405, 'Method not allowed'); return;
    }
    let pathname;
    try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0]); }
    catch { respond(400, 'Invalid path'); return; }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) {
      respond(400, 'Invalid path'); return;
    }
    if (pathname === '/health') { respond(200, JSON.stringify({ status: 'ok' }), contentTypes['.json']); return; }
    if (pathname === '/health/ready' || pathname === '/health/runtime') {
      let source, failed = false;
      try {
        source = runtimeDiagnostics?.() ?? {};
        if (typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid runtime diagnostics');
      } catch { source = { draining: true }; failed = true; }
      if (pathname === '/health/ready') {
        const status = failed ? 'unavailable' : source.draining === true ? 'draining' : 'ready';
        respond(status === 'ready' ? 200 : 503, JSON.stringify({ status }), contentTypes['.json']); return;
      }
      const summary = { draining: source.draining === true };
      for (const field of runtimeFields) {
        summary[field] = Number.isFinite(source[field]) ? Math.max(0, source[field]) : 0;
      }
      respond(failed ? 503 : 200, JSON.stringify(summary), contentTypes['.json']); return;
    }
    if (pathname === '/health/storage') {
      let source;
      try { source = storageDiagnostics?.() ?? { status: 'disabled' }; }
      catch { source = { status: 'degraded', invalid: 1 }; }
      const status = ['ok', 'degraded', 'disabled'].includes(source.status) ? source.status : 'degraded';
      const summary = { status };
      for (const field of ['pending', 'retrying', 'failed', 'invalid', 'active', 'capacity']) {
        const value = source[field] ?? (field === 'capacity' ? 1000 : 0);
        summary[field] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      }
      respond(status === 'degraded' ? 503 : 200, JSON.stringify(summary), contentTypes['.json']); return;
    }
    if (pathname === '/api/leaderboard') {
      try { respond(200, JSON.stringify(await getLeaderboard(env)), contentTypes['.json']); }
      catch { respond(503, JSON.stringify({ error: 'leaderboard_unavailable' }), contentTypes['.json']); }
      return;
    }
    if (pathname === '/api/config') {
      respond(200, JSON.stringify({
        allowDevGuests: env.ALLOW_DEV_GUESTS === 'true',
        supabaseUrl: env.SUPABASE_URL || '',
        supabaseAnonKey: env.SUPABASE_ANON_KEY || ''
      }), contentTypes['.json']);
      return;
    }
    try {
      const candidate = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(candidate)]);
      if (!actualFile.startsWith(actualRoot + path.sep)) { respond(404, 'Not found'); return; }
      const contentType = contentTypes[path.extname(actualFile)];
      if (!contentType) { respond(404, 'Not found'); return; }
      const data = await readFile(actualFile);
      respond(200, data, contentType);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES'].includes(error.code)) respond(404, 'Not found');
      else { console.error('Static asset request failed', error.code); respond(500, 'Request failed'); }
    }
  };
}
