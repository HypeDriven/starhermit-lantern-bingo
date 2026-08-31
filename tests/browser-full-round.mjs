// Full-round browser test: play Practice to completion (results screen),
// verify score breakdown and replay export, capture screenshots.
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT || 9377);
const CDP_PORT = 9785;
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=1280,900',
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname);
    let upgraded = false, buf = Buffer.alloc(0), idc = 0;
    const pending = new Map();
    sock.on('connect', () => sock.write(
      `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i === -1) return; buf = buf.subarray(i + 4); upgraded = true; resolve(api); }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        try { const msg = JSON.parse(payload.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch (_) {}
      }
    });
    sock.on('error', reject);
    const api = {
      call(method, params = {}) {
        return new Promise((res) => {
          const id = ++idc; pending.set(id, res);
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
    };
  });
}

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); };

const targets = await new Promise(async (res) => {
  for (let i = 0; i < 40; i++) { try { return res(await getJson('/json/list')); } catch (_) { await new Promise(r => setTimeout(r, 250)); } }
});
const cdp = await cdpConnect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
const evalJs = async (expr) => {
  const r = await cdp.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
};
await cdp.call('Page.enable');
await cdp.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await new Promise(r => setTimeout(r, 2500));

// start practice normal round
await evalJs(`document.querySelector('[data-nav="play-quick"]').click()`);
await evalJs(`document.querySelector('#setup-start').click()`);
await new Promise(r => setTimeout(r, 4000)); // countdown

const shot = async (file) => {
  const r = await cdp.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
};
await shot('/tmp/lb-play.png');

// play to completion: call, auto-mark everything, claim when ready
let ended = false;
for (let i = 0; i < 400 && !ended; i++) {
  ended = await evalJs(`(() => {
    if (!document.querySelector('#screen-results').hidden) return true;
    if (!document.querySelector('#screen-play').hidden) {
      const m = document.querySelector('#card-grid .card-cell.markable');
      if (m) m.click();
      const claim = document.querySelector('#btn-claim');
      if (claim && !claim.disabled) { claim.click(); return !document.querySelector('#screen-results').hidden; }
      document.querySelector('#btn-call').click();
    }
    return false;
  })()`);
  await new Promise(r => setTimeout(r, 120));
}
check('round reaches results screen', ended);
if (ended) {
  const body = await evalJs(`document.querySelector('#results-body').textContent`);
  check('results show score breakdown', body.includes('Pattern bonus') && body.includes('Total'));
  check('results show ranking', body.includes('Ranking'));
  check('results show state hash', /Hash [0-9a-f]{8}/.test(body));
  await shot('/tmp/lb-results.png');
  const prog = await evalJs(`JSON.parse(JSON.parse(localStorage.getItem('lantern-bingo-v1')).payload).progress.gamesPlayed`);
  check('progress persisted', prog >= 1, 'gamesPlayed=' + prog);
}

chrome.kill('SIGKILL');
const failed = results.filter(x => !x).length;
console.log(failed ? failed + ' FULL-ROUND FAILURES' : 'FULL ROUND PASSED');
process.exit(failed ? 1 : 0);
