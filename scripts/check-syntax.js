#!/usr/bin/env node
'use strict';

/**
 * Static consistency checks that need no bundler and no browser:
 *
 *   1. every server file parses (`node --check`)
 *   2. every browser module parses as ESM
 *   3. every relative import in browser code resolves, and names a real export
 *   4. every `api.*('/api/...')` call in browser code matches a registered route
 *   5. every local href/src in an HTML page points at a file that exists
 *   6. every workspace page carries the shell anchors its module expects
 *
 * These catch the class of mistake a no-build front end is most prone to: a
 * renamed export, a typo'd endpoint, a stylesheet that was never created.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// vm.SourceTextModule needs a flag; re-exec once with it rather than asking the caller.
if (typeof vm.SourceTextModule !== 'function') {
  const child = require('node:child_process').spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', __filename],
    { stdio: 'inherit' }
  );
  process.exit(child.status ?? 1);
}

const problems = [];
const report = (message) => problems.push(message);
const rel = (file) => path.relative(root, file);

function walk(directory, extension, { skip = [] } = {}) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, extension, { skip }));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

/**
 * Replaces every `${...}` with a placeholder, tracking nested braces so an
 * interpolation containing an object literal is removed whole.
 */
function stripInterpolations(text) {
  let output = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      i -= 1;
      output += '\u0001'; // placeholder for "some runtime value"
    } else {
      output += text[i];
    }
  }
  return output;
}

// ---------------------------------------------------------------- 1. server JS
const serverFiles = [
  path.join(root, 'server.js'),
  ...walk(path.join(root, 'src'), '.js'),
  ...walk(path.join(root, 'scripts'), '.js')
];
for (const file of serverFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    report(`${rel(file)} failed to parse\n${error.stderr?.toString().trim() || error.message}`);
  }
}

// --------------------------------------------------- 2 + 3. browser ESM parsing
const browserFiles = walk(path.join(root, 'public', 'assets', 'js'), '.js');
const exportsOf = new Map();

for (const file of browserFiles) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    new vm.SourceTextModule(source, { identifier: file });
  } catch (error) {
    report(`${rel(file)} failed to parse as an ES module\n  ${error.message}`);
    continue;
  }

  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) names.add('default');
  exportsOf.set(path.resolve(file), names);
}

for (const file of browserFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[3];
    if (!specifier.startsWith('.')) continue;

    const target = path.resolve(path.dirname(file), specifier);
    if (!fs.existsSync(target)) {
      report(`${rel(file)} imports '${specifier}', which does not exist`);
      continue;
    }
    const available = exportsOf.get(target);
    if (!available) continue;
    for (const part of (match[2] || '').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && !available.has(name)) {
        report(`${rel(file)} imports '${name}' from '${specifier}', which does not export it`);
      }
    }
  }
}

// ------------------------------------------------- 4. front-end calls vs routes
const registeredRoutes = [['GET', '/api/health']];
for (const file of walk(path.join(root, 'src', 'server', 'routes'), '.js')) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
    registeredRoutes.push([match[1].toUpperCase(), match[2]]);
  }
}

// A :param segment stands for one concrete path segment.
const concreteRoute = (pattern) => pattern.replace(/:[A-Za-z0-9_]+/g, 'x');

/**
 * Turns a call-site template into a matcher. `\u0001` (an interpolation) becomes
 * `[^/]*` so it covers both an id segment and an appended query string, which is
 * why `/api/talent${qs(...)}` still matches the bare `/api/talent` route.
 */
function callMatcher(pathname) {
  const escaped = pathname
    .split('\u0001')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

const seenCalls = new Set();

for (const file of browserFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/api\.(get|post|patch|put|delete)\(\s*(`[^`]*`|'[^']*')/g)) {
    const method = match[1].toUpperCase();
    const literal = match[2].slice(1, -1);
    const pathname = stripInterpolations(literal).split('?')[0];
    if (!pathname.startsWith('/api')) continue;

    const display = `${method} ${pathname.replace(/\u0001/g, '{}')}`;
    if (seenCalls.has(display)) continue;
    seenCalls.add(display);

    const matcher = callMatcher(pathname);
    const matched = registeredRoutes.some(([routeMethod, routePath]) => (
      routeMethod === method && matcher.test(concreteRoute(routePath))
    ));
    if (!matched) report(`${rel(file)} calls ${display}, which matches no registered route`);
  }
}

// ---------------------------------------------------- 5 + 6. HTML page wiring
const pages = walk(path.join(root, 'public'), '.html', { skip: ['assets'] });
for (const file of pages) {
  const source = fs.readFileSync(file, 'utf8');

  for (const match of source.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
    const reference = match[1].split(/[?#]/)[0];
    if (!reference || reference.endsWith('/')) continue;
    if (!fs.existsSync(path.join(root, 'public', reference))) {
      report(`${rel(file)} references ${reference}, which does not exist`);
    }
  }

  if (file.includes(`${path.sep}app${path.sep}`)) {
    for (const anchor of ['id="workspace"', 'id="page"']) {
      if (!source.includes(anchor)) report(`${rel(file)} is missing ${anchor}`);
    }
  }
  if (!/<script type="module"/.test(source) && !file.endsWith('404.html')) {
    report(`${rel(file)} has no module script`);
  }
}

// ------------------------------------------------------------------- summary
if (problems.length) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}

console.log([
  'checks passed:',
  `  ${serverFiles.length} server files parse`,
  `  ${browserFiles.length} browser modules parse, and every relative import resolves`,
  `  ${seenCalls.size} distinct front-end API calls match a registered route`,
  `  ${pages.length} HTML pages reference only files that exist`
].join('\n'));
