/* Minimal Chrome DevTools Protocol client.
 *
 * There is no puppeteer/playwright in this repo and none is needed: Node's
 * built-in WebSocket talks to Chrome directly, so this file has no dependencies.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error(
    'Chrome not found. Set CHROME=/path/to/chrome. Tried:\n  ' + CHROME_CANDIDATES.join('\n  ')
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts headless Chrome and resolves once its CDP endpoint answers. */
async function launch(port = 9222) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-chrome-'));
  const proc = spawn(findChrome(), [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ], { stdio: 'ignore', detached: false });

  for (let i = 0; i < 60; i++) {
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version');
      return {
        proc,
        close() {
          try { proc.kill(); } catch {}
          try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
        },
      };
    } catch {
      await sleep(250);
    }
  }
  try { proc.kill(); } catch {}
  throw new Error('Chrome did not open a CDP port within 15s');
}

async function connect(port = 9222) {
  const ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const handlers = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      handlers.forEach((h) => h(msg));
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const m = { id: ++id, method, params };
      if (sessionId) m.sessionId = sessionId;
      pending.set(m.id, { res, rej });
      ws.send(JSON.stringify(m));
    });

  return { ws, send, on: (h) => handlers.push(h) };
}

/** Opens a tab, waits for load, and returns a session-bound `send`. */
async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  if (url) {
    const loaded = new Promise((res) => {
      cdp.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') res(); });
    });
    await s('Page.navigate', { url });
    await loaded;
  }
  return { s, targetId, sessionId };
}

async function evalJs(s, expression) {
  const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

module.exports = { launch, connect, newPage, evalJs, findChrome, sleep };
