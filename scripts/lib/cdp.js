'use strict';

// A minimal Chrome DevTools Protocol client — enough to drive headless Chrome for
// browser smoke tests without taking a dependency. Uses Node's global WebSocket.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RawWebSocket } = require('./websocket');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  for (const candidate of [process.env.CHROME_PATH, ...CHROME_CANDIDATES]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Polls /json/version until the debugging port answers, then returns its ws URL. */
async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(150);
  }
  throw new Error(`Chrome DevTools did not open on port ${port}: ${lastError}`);
}

/**
 * Launches headless Chrome and returns a browser handle.
 * `newPage()` opens a target and returns a page bound to its session.
 */
async function launch({ port = 9222 + Math.floor(Math.random() * 500) } = {}) {
  const binary = findChrome();
  if (!binary) throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH.');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-cdp-'));
  const child = spawn(binary, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // Chrome's own sandbox cannot initialise inside a restricted file sandbox and
    // the process dies about a second after launch. These two keep it alive; the
    // browser only ever loads localhost pages from this repo.
    '--no-sandbox',
    '--disable-crashpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: 'ignore' });

  // A Chrome that dies mid-run should surface as a clear error, not a CDP timeout.
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

  const browserWsUrl = await waitForDevTools(port);
  const socket = new RawWebSocket(browserWsUrl);
  await socket.waitForOpen();

  let nextId = 1;
  const pending = new Map();
  const sessionListeners = new Map();

  socket.on('close', (code) => {
    const detail = exitInfo
      ? `Chrome exited (code ${exitInfo.code}, signal ${exitInfo.signal})`
      : `Chrome connection closed (code ${code})`;
    for (const { reject } of pending.values()) reject(new Error(detail));
    pending.clear();
  });

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw);
    if (frame.id && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(`${frame.method || 'CDP'}: ${frame.error.message}`));
      else resolve(frame.result);
      return;
    }
    if (frame.method && frame.sessionId) {
      for (const listener of [...(sessionListeners.get(frame.sessionId) || [])]) listener(frame);
    }
  });

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async function newPage() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

    const consoleMessages = [];
    const pageErrors = [];
    const failedRequests = [];
    const listeners = [];
    sessionListeners.set(sessionId, listeners);

    listeners.push((frame) => {
      if (frame.method === 'Runtime.consoleAPICalled') {
        const text = (frame.params.args || [])
          .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? arg.type)
          .join(' ');
        consoleMessages.push({ type: frame.params.type, text });
      } else if (frame.method === 'Runtime.exceptionThrown') {
        const details = frame.params.exceptionDetails;
        pageErrors.push(details.exception?.description || details.text || 'unknown error');
      } else if (frame.method === 'Log.entryAdded' && frame.params.entry.level === 'error') {
        const entry = frame.params.entry;
        pageErrors.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
      } else if (frame.method === 'Network.loadingFailed') {
        failedRequests.push(frame.params.errorText);
      }
    });

    const call = (method, params) => send(method, params, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Log.enable');
    await call('Network.enable');

    const page = {
      sessionId,
      consoleMessages,
      pageErrors,
      failedRequests,
      call,

      /** Navigates and waits for the load event plus a settle delay for module execution. */
      async goto(url, { settle = 700 } = {}) {
        const loaded = new Promise((resolve) => {
          const onLoad = (frame) => {
            if (frame.method === 'Page.loadEventFired') {
              listeners.splice(listeners.indexOf(onLoad), 1);
              resolve();
            }
          };
          listeners.push(onLoad);
        });
        const result = await call('Page.navigate', { url });
        if (result.errorText) throw new Error(`navigate ${url}: ${result.errorText}`);
        await Promise.race([loaded, sleep(15000)]);
        await sleep(settle);
        return result;
      },

      /**
       * Runs a body of JS in the page and returns its JSON value.
       * The body is wrapped in an async IIFE, so `await` and `return` both work.
       */
      async eval(body) {
        const result = await call('Runtime.evaluate', {
          expression: `(async () => { ${body} })()`,
          returnByValue: true,
          awaitPromise: true
        });
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result.value;
      },

      /**
       * Polls until the code yields something truthy.
       * Accepts either a bare expression or statements containing `return`.
       */
      async waitFor(code, { timeout = 8000, interval = 120 } = {}) {
        const body = /\breturn\b/.test(code) ? code : `return (${code});`;
        const deadline = Date.now() + timeout;
        let lastError = null;
        while (Date.now() < deadline) {
          try {
            const value = await page.eval(body);
            if (value) return value;
            lastError = null;
          } catch (error) {
            lastError = error;
          }
          await sleep(interval);
        }
        throw new Error(`waitFor timed out: ${code.trim().slice(0, 160)}${lastError ? ` (last error: ${lastError.message})` : ''}`);
      },

      async click(selector) {
        const ok = await page.eval(`
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return false;
          node.click();
          return true;
        `);
        if (!ok) throw new Error(`click: no element matches ${selector}`);
        await sleep(250);
      },

      async type(selector, value) {
        const ok = await page.eval(`
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return false;
          node.value = ${JSON.stringify(value)};
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        `);
        if (!ok) throw new Error(`type: no element matches ${selector}`);
      },

      async screenshot(file) {
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return file;
      },

      /** Errors that matter: page exceptions, console errors, and real request failures. */
      hardErrors() {
        return [
          ...pageErrors,
          ...consoleMessages.filter((message) => message.type === 'error').map((message) => message.text),
          ...failedRequests.filter((text) => text && text !== 'net::ERR_ABORTED')
        ];
      },

      clearErrors() {
        pageErrors.length = 0;
        consoleMessages.length = 0;
        failedRequests.length = 0;
      },

      async close() {
        sessionListeners.delete(sessionId);
        await send('Target.closeTarget', { targetId });
      }
    };

    return page;
  }

  return {
    newPage,
    async close() {
      try { socket.close(); } catch { /* already closed */ }
      child.kill('SIGTERM');
      await sleep(200);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

module.exports = { launch, findChrome, sleep };
