'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { openDatabase } = require('./db');
const { seed } = require('./seed');
const { Router } = require('./router');
const auth = require('./auth');
const { HttpError, notFound } = require('./validate');
const { ApiResponse, readJsonBody } = require('./http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.webmanifest']);

/**
 * Content-Security-Policy allows Google Fonts (the design depends on them) and
 * nothing else off-origin. No inline scripts are used anywhere in the app.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'"
].join('; ');

function securityHeaders(secure) {
  const headers = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function createApp(options = {}) {
  const root = options.root || path.join(__dirname, '..', '..');
  const publicDir = options.publicDir || path.join(root, 'public');
  const dbFile = options.dbFile || path.join(root, 'data', 'horizon.db');
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const trustProxy = options.trustProxy ?? false;

  const db = openDatabase(dbFile);
  if (options.seed !== false) seed(db, { withDemoData: options.demoData !== false });

  const router = new Router();
  require('./routes/auth.routes').register(router);
  require('./routes/talent.routes').register(router);
  require('./routes/briefs.routes').register(router);
  require('./routes/projects.routes').register(router);
  require('./routes/admin.routes').register(router);

  // Database-backed so the allowance survives a restart.
  const inquiryLimiter = auth.createDbRateLimiter({ windowMs: 60 * 60 * 1000, max: 15, name: 'inquiry' });
  const apiLimiter = auth.createDbRateLimiter({ windowMs: 60 * 1000, max: 300, name: 'api' });
  const staticCache = new Map();

  function clientKey(request) {
    if (trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      if (forwarded) return String(forwarded).split(',')[0].trim();
    }
    return request.socket.remoteAddress || 'unknown';
  }

  function send(response, status, body, headers = {}) {
    const payload = body === null || body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...securityHeaders(secureCookies),
      ...headers
    });
    response.end(payload);
  }

  async function serveStatic(request, response, pathname) {
    // Pretty URLs: /login → /login.html, /app/briefs → /app/briefs.html
    const candidates = [];
    const clean = pathname.replace(/\/+$/, '') || '/';
    if (clean === '/') candidates.push('index.html');
    else {
      const relative = clean.slice(1);
      candidates.push(relative);
      if (!path.extname(relative)) candidates.push(`${relative}.html`, path.join(relative, 'index.html'));
    }

    for (const candidate of candidates) {
      const filePath = path.resolve(publicDir, candidate);
      const relativeToRoot = path.relative(publicDir, filePath);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) continue;

      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }
      if (!stat.isFile()) continue;

      const extension = path.extname(filePath).toLowerCase();
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      const headers = {
        'Content-Type': MIME[extension] || 'application/octet-stream',
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString(),
        'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
        ...securityHeaders(secureCookies)
      };

      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, headers);
        return response.end();
      }

      let content = staticCache.get(`${filePath}:${etag}`);
      if (!content) {
        content = await fsp.readFile(filePath);
        staticCache.set(`${filePath}:${etag}`, content);
        if (staticCache.size > 120) staticCache.delete(staticCache.keys().next().value);
      }

      const wantsGzip = /\bgzip\b/.test(request.headers['accept-encoding'] || '');
      if (wantsGzip && COMPRESSIBLE.has(extension) && content.length > 1024) {
        const gzipped = zlib.gzipSync(content);
        response.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gzipped.length, Vary: 'Accept-Encoding' });
        return response.end(request.method === 'HEAD' ? undefined : gzipped);
      }

      response.writeHead(200, { ...headers, 'Content-Length': content.length });
      return response.end(request.method === 'HEAD' ? undefined : content);
    }

    // SPA-less fallback: serve the 404 page for navigations, JSON otherwise.
    const notFoundPage = path.join(publicDir, '404.html');
    if (fs.existsSync(notFoundPage) && (request.headers.accept || '').includes('text/html')) {
      const content = await fsp.readFile(notFoundPage);
      response.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': content.length, ...securityHeaders(secureCookies) });
      return response.end(content);
    }
    return send(response, 404, { error: 'Not found.' });
  }

  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      return send(response, 400, { error: 'Malformed request URL.' });
    }
    const { pathname } = url;
    const method = (request.method || 'GET').toUpperCase();

    try {
      if (pathname === '/api/health') {
        return send(response, 200, { ok: true, uptime: Math.round(process.uptime()), version: 2 });
      }

      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          return send(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        }
        return await serveStatic(request, response, pathname);
      }

      apiLimiter(db, `api:${clientKey(request)}`);

      const match = router.find(method, pathname);
      if (!match) throw notFound('That endpoint does not exist.');
      if (!match.handler) {
        return send(response, 405, { error: 'Method not allowed.' }, { Allow: match.allowed.join(', ') });
      }

      const session = auth.currentSession(db, request);

      // Same-origin check for state-changing requests, then CSRF token.
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = request.headers.origin;
        if (origin) {
          const host = request.headers.host;
          let originHost = '';
          try { originHost = new URL(origin).host; } catch { originHost = 'invalid'; }
          if (originHost !== host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
        }
        const isPublicPost = ['/api/auth/login', '/api/auth/signup', '/api/inquiries', '/api/auth/logout'].includes(pathname);
        if (!isPublicPost) auth.assertCsrf(session, request);
      }

      const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(request);
      const cookies = [];

      const context = {
        db, url, params: match.params, body, request, response, session,
        clientKey: clientKey(request), inquiryLimiter,
        setSession(created) {
          cookies.push(auth.sessionCookie(created.sessionId, { secure: secureCookies, maxAge: auth.SESSION_DAYS * 86400 }));
        },
        clearSession() {
          cookies.push(auth.sessionCookie('', { secure: secureCookies, maxAge: 0 }));
        }
      };

      const result = await match.handler(context);
      const headers = cookies.length ? { 'Set-Cookie': cookies } : {};

      if (result instanceof ApiResponse) {
        return send(response, result.status, result.body, { ...headers, ...result.headers });
      }
      return send(response, 200, result ?? { ok: true }, headers);
    } catch (error) {
      if (error instanceof HttpError) {
        const payload = { error: error.message };
        if (error.details) payload.details = error.details;
        return send(response, error.status, payload);
      }
      const reference = crypto.randomBytes(4).toString('hex');
      console.error(`[error ${reference}] ${method} ${pathname}`, error);
      return send(response, 500, { error: 'Something went wrong on our side.', reference });
    }
  });

  return {
    server,
    db,
    listen: (port, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(() => { try { db.close(); } catch { /* already closed */ } resolve(); }))
  };
}

module.exports = { createApp, securityHeaders, MIME };
