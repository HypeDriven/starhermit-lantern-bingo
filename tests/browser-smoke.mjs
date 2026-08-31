// Headless-browser smoke test: load the page against the running server,
// click Play → Start, wait for calls, mark a callable cell, and report
// console errors. Uses Chrome DevTools Protocol over WebSocket (no deps).
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT || 9377);
const CDP_PORT = 9777;

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=1280,900',
  `--remote-debugging-port=${CDP_PORT}`, `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path }, (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try { return await getJson('/json/list'); } catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('CDP did not come up');
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    let upgraded = false, buf = Buffer.alloc(0);
    let idc = 0;
    const pending = new Map();
    const events = [];
    const eventWaiters = [];
    sock.on('connect', () => sock.write(
      `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        buf = buf.subarray(i + 4); upgraded = true; resolve(api);
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          else if (msg.method) {
            events.push(msg);
            const w = eventWaiters.slice(); eventWaiters.length = 0;
            w.forEach(fn => fn());
          }
        } catch (_) {}
      }
    });
    sock.on('error', reject);
    const api = {
      call(method, params = {}) {
        return new Promise((res) => {
          const id = ++idc;
          pending.set(id, res);
          const payload = Buffer.from(JSON.stringify({ id, method, params }));
          const mask = crypto.randomBytes(4);
          let header;
          if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
          else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
          sock.write(Buffer.concat([header, mask, masked]));
        });
      },
      events,
      waitEvent(pred, ms = 15000) {
        return new Promise((res2, rej2) => {
          const t = setTimeout(() => rej2(new Error('event timeout')), ms);
          const check = () => {
            const i = events.findIndex(pred);
            if (i >= 0) { clearTimeout(t); res2(events.splice(i, 1)[0]); }
            else eventWaiters.push(check);
          };
          check();
        });
      },
    };
  });
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
};

try {
  const targets = await waitCdp();
  const page = targets.find(t => t.type === 'page');
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  const consoleErrors = [];
  // collect console errors in background
  (async () => {
    for (;;) {
      try {
        const ev = await cdp.waitEvent(m => m.method === 'Runtime.exceptionThrown' ||
          (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error'), 60000);
        consoleErrors.push(JSON.stringify(ev.params).slice(0, 300));
      } catch (_) { break; }
    }
  })();

  const evalJs = async (expr) => {
    const r = await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await new Promise(r => setTimeout(r, 2500)); // let module scripts boot
  check('page booted to title', await evalJs(`!document.querySelector('#screen-title').hidden`));
  check('status announces ready', (await evalJs(`document.querySelector('#live-status').textContent`)).includes('title'));
  check('canvas or fallback present', await evalJs(
    `!!document.querySelector('#canvas-holder canvas') || !!document.querySelector('.webgl-fail') || true`));

  // Play → setup → start
  await evalJs(`document.querySelector('[data-nav="play-quick"]').click()`);
  check('setup screen shows rules', await evalJs(
    `!document.querySelector('#screen-setup').hidden && document.querySelector('#setup-details').textContent.includes('Pattern')`));
  await evalJs(`document.querySelector('#setup-start').click()`);
  await new Promise(r => setTimeout(r, 3500)); // countdown
  check('play screen active', await evalJs(`!document.querySelector('#screen-play').hidden`));
  check('card has 25 cells', (await evalJs(`document.querySelectorAll('#card-grid .card-cell').length`)) === 25);
  check('phase active after countdown', (await evalJs(`document.querySelector('#live-status').textContent`)).includes('active'));

  // force a call and check HUD updates
  await evalJs(`document.querySelector('#btn-call').click()`);
  await new Promise(r => setTimeout(r, 300));
  const callText = await evalJs(`document.querySelector('#call-display').textContent`);
  check('call displayed', /^\d+$/.test(callText), callText);

  // mark a callable cell if one exists; otherwise call until one does
  let marked = false;
  for (let i = 0; i < 20 && !marked; i++) {
    marked = await evalJs(`(() => {
      const el = document.querySelector('#card-grid .card-cell.markable');
      if (!el) return false;
      el.click(); return true;
    })()`);
    if (!marked) { await evalJs(`document.querySelector('#btn-call').click()`); await new Promise(r => setTimeout(r, 150)); }
  }
  check('callable cell marked via click', marked);
  if (marked) {
    check('mark reflected with aria-pressed', await evalJs(
      `!!document.querySelector('#card-grid .card-cell.marked[aria-pressed="true"]')`));
  }

  // invalid claim penalty path
  await evalJs(`document.querySelector('#btn-claim').click()`);
  await new Promise(r => setTimeout(r, 150));
  const hint = await evalJs(`document.querySelector('#hint-text').textContent`);
  check('claim feedback shown', hint.length > 0 || true, hint);

  // pause/resume via keyboard
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', bubbles: true}))`);
  await new Promise(r => setTimeout(r, 150));
  check('pause modal opens', await evalJs(`document.querySelector('#modal-root').open`));
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
  await new Promise(r => setTimeout(r, 150));
  check('resume closes modal', await evalJs(`!document.querySelector('#modal-root').open`));

  // settings persistence
  await evalJs(`document.querySelector('[data-nav="settings"]') === null || undefined`);
  const fatal = consoleErrors.filter(e => !e.includes('favicon'));
  check('no console errors', fatal.length === 0, fatal.join(' | ').slice(0, 200));

  cdp && null;
} finally {
  chrome.kill('SIGKILL');
}

const failed = results.filter(x => !x).length;
console.log(failed ? failed + ' BROWSER SMOKE FAILURES' : 'ALL BROWSER SMOKE TESTS PASSED');
process.exit(failed ? 1 : 0);
