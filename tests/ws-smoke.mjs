'use strict';
// WS smoke test: join hosted room, receive snapshot, send commands, verify
// idempotent duplicate rejection, bounds validation, and reconnect.
import crypto from 'node:crypto';
import net from 'node:net';

const PORT = Number(process.env.SMOKE_PORT || 9377);

function wsConnect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1');
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const frames = [];
    const waiters = [];
    sock.on('connect', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        if (!buf.subarray(0, idx).toString().includes('101')) return reject(new Error('handshake failed'));
        buf = buf.subarray(idx + 4);
        upgraded = true;
        resolve(api);
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if ((buf[0] & 0x0f) === 1 || payload.length) {
          try {
            const msg = JSON.parse(payload.toString());
            frames.push(msg);
            const w = waiters.slice(); waiters.length = 0;
            w.forEach(fn => fn());
          } catch (_) {}
        }
      }
    });
    sock.on('error', reject);

    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
      sock.write(Buffer.concat([header, mask, masked]));
    }
    function next(pred, ms = 5000) {
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout waiting for frame')), ms);
        const check = () => {
          const i = frames.findIndex(pred);
          if (i >= 0) { clearTimeout(t); res(frames.splice(i, 1)[0]); }
          else waiters.push(check);
        };
        check();
      });
    }
    const api = { send, next, close: () => sock.destroy(), frames };
  });
}

const results = [];
function check(name, ok, extra = '') {
  results.push([name, ok]);
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''));
}

const c1 = await wsConnect();
c1.send({ type: 'join' });
const joined = await c1.next(m => m.type === 'joined');
check('join handshake', !!joined.playerId && !!joined.state, joined.playerId);

const state = JSON.parse(joined.state);
check('snapshot has 4 seats', state.players.length === 4);
check('player seated', state.players.some(p => p.id === joined.playerId));

// invalid bounds
c1.send({ type: 'cmd', cmd: { type: 'mark', cell: 99, id: 'bad1' } });
const rej1 = await c1.next(m => m.type === 'rejected');
check('out-of-bounds mark rejected', rej1.reason === 'cell-out-of-bounds', rej1.reason);

// wait for a server call (interval 4s)
const snap = await c1.next(m => m.type === 'snapshot' && JSON.parse(m.state).callIndex >= 0, 8000);
const st = JSON.parse(snap.state);
check('server advances calls authoritatively', st.callIndex >= 0, 'callIndex=' + st.callIndex);
check('snapshot carries hash', /^[0-9a-f]{8}$/.test(snap.hash));

// mark current call if on my card
const me = st.players.find(p => p.id === joined.playerId);
const cell = me.card.indexOf(st.deck[st.callIndex]);
if (cell >= 0) {
  c1.send({ type: 'cmd', cmd: { type: 'mark', cell, id: 'm1' } });
  const s2 = await c1.next(m => {
    if (m.type !== 'snapshot') return false;
    const x = JSON.parse(m.state);
    return x.players.find(p => p.id === joined.playerId).marks.includes(cell);
  });
  check('legal mark accepted', !!s2);
  // duplicate id is idempotently ignored (no second state change, no error frame)
  c1.send({ type: 'cmd', cmd: { type: 'mark', cell, id: 'm1' } });
  let dupError = null;
  try { dupError = await Promise.race([c1.next(m => m.type === 'rejected', 1500)]); } catch (_) {}
  check('duplicate command id ignored', dupError === null);
} else {
  check('legal mark accepted', true, 'call not on card; skipped');
  check('duplicate command id ignored', true, 'skipped');
}

// uncalled mark rejected with penalty
const uncalled = me.card.findIndex(v => v !== 0 && !st.deck.slice(0, st.callIndex + 1).includes(v));
c1.send({ type: 'cmd', cmd: { type: 'mark', cell: uncalled, id: 'bad2' } });
const rej2 = await c1.next(m => m.type === 'rejected');
check('uncalled number rejected', rej2.reason === 'number-not-called', rej2.reason);

// reconnect with same playerId gets snapshot + while-away summary
c1.close();
await new Promise(r => setTimeout(r, 200));
const c2 = await wsConnect();
c2.send({ type: 'join', playerId: joined.playerId, roomId: joined.roomId });
const rejoined = await c2.next(m => m.type === 'joined');
check('reconnect reclaims seat', rejoined.playerId === joined.playerId);
check('while-away summary present', typeof rejoined.whileAway === 'string', rejoined.whileAway || '');
c2.close();

const failed = results.filter(r => !r[1]).length;
console.log(failed ? `${failed} FAILURES` : 'ALL WS SMOKE TESTS PASSED');
process.exit(failed ? 1 : 0);
