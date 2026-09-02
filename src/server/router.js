'use strict';

/**
 * Tiny pattern router. Paths use `:param` segments; matches return decoded params.
 * Registration order is preserved, first match wins.
 */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, pattern, segments, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  patch(pattern, handler) { return this.add('PATCH', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  /** Returns { handler, params } or null; `allowed` lists methods for a path-only match. */
  find(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const allowed = new Set();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let matched = true;
      for (let index = 0; index < parts.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[index]);
        else if (segment !== parts[index]) { matched = false; break; }
      }
      if (!matched) continue;
      if (route.method !== method) { allowed.add(route.method); continue; }
      return { handler: route.handler, params };
    }
    return allowed.size ? { allowed: [...allowed] } : null;
  }
}

module.exports = { Router };
