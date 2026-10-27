// server.js in the platform's own script sandbox: the StarHermit platform's
// script worker (Platform.ScriptRunner, Jint, strict mode) under the default
// per-invocation budgets (250 ms, 32 MB, 5M statements). A hosted hall of
// two players and two bot lanterns is played to its result at the script's
// 4 Hz tick, and a score is posted on a practice session; every invocation
// must succeed well within the budgets. Skipped when the worker is not built here
// (SH_SCRIPT_RUNNER names its dll; default
// ~/sh/starhermit/src/Platform.ScriptRunner/bin/Debug/net8.0). After
// hidden-council's tests/jint.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legalActions, patternComplete } from '../js/rules.js';

const DLL = process.env.SH_SCRIPT_RUNNER
  || join(homedir(), 'sh/starhermit/src/Platform.ScriptRunner/bin/Debug/net8.0/Platform.ScriptRunner.dll');
const SOURCE = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
let dotnet = false;
try { execFileSync('dotnet', ['--list-runtimes'], { stdio: 'pipe' }); dotnet = true; } catch { dotnet = false; }
const skip = !dotnet || !existsSync(DLL) ? 'the platform script worker is not built here' : false;

function worker() {
  const p = spawn('dotnet', [DLL], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  p.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const n = buf.readInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
      buf = buf.subarray(4 + n);
      waiters.shift()(msg);
    }
  });
  const next = () => new Promise((r) => waiters.push(r));
  const ready = next();
  let sent = false;
  return {
    ready,
    async invoke(entryPoint, ctx) {
      const body = Buffer.from(JSON.stringify({
        op: 'invoke', scriptKey: 'lantern-bingo', source: sent ? null : SOURCE,
        gameId: '00000000-0000-0000-0000-0000000000cd', slug: 'lantern-bingo', scriptVersion: 1,
        cpuMillis: 250, memoryBytes: 32 * 1024 * 1024, maxStatements: 5_000_000,
        entryPoint, context: JSON.stringify(ctx),
      }));
      sent = true;
      const head = Buffer.alloc(4);
      head.writeInt32LE(body.length);
      p.stdin.write(Buffer.concat([head, body]));
      let r = await next();
      if (r.needSource) { sent = false; return this.invoke(entryPoint, ctx); }
      assert.ok(r.ok, `${entryPoint}: ${r.failure} ${r.message || ''}`);
      const value = JSON.parse(r.return);
      assert.ok(value.ok, `${entryPoint} refused: ${value.error}`);
      return { value, ms: r.elapsedMillis };
    },
    close() { p.stdin.end(); },
  };
}

test('server.js referees a whole hall and posts a score inside the platform sandbox', { skip, timeout: 600_000 }, async () => {
  const w = worker();
  try {
    await w.ready;
    const humans = ['a', 'b'];
    const roster = humans.map((id, i) => ({ userId: id, name: id.toUpperCase(), team: 0, slot: i, ai: false }));
    const presence = Object.fromEntries(humans.map((id) => [id, { online: true, left: false }]));
    let now = Date.UTC(2026, 9, 27, 12);
    const ctx = (extra) => ({
      now, random: 0.42, sessionId: 's', playerStates: {},
      players: humans.map((id) => ({ id, name: id.toUpperCase(), elo: 1200 })),
      room: { roomId: 'r', metadata: { mode: 'hall' }, roster }, presence, ...extra,
    });
    let { value } = await w.invoke('createSession', ctx({ sessionState: null }));
    let ss = value.sessionState, result = null, worst = 0;
    for (let i = 0; i < 3000 && !result; i++) {
      now += 250;
      const t = await w.invoke('onTick', ctx({ sessionState: ss }));
      worst = Math.max(worst, t.ms);
      if (t.value.sessionState) ss = t.value.sessionState;
      if (t.value.result) { result = t.value.result; break; }
      for (const [u, pid] of [['a', 'p1'], ['b', 'p2']]) {
        const m = legalActions(ss.state, pid).find((x) => x.type === 'mark');
        const cmds = m ? m.cells.map((cell) => ({ type: 'mark', cell })) : [];
        for (const cmd of cmds) {
          const r = await w.invoke('onPlayerMessage', ctx({ sessionState: ss, message: { from: u, data: { type: 'act', cmd } } }));
          worst = Math.max(worst, r.ms);
          if (r.value.sessionState) ss = r.value.sessionState;
        }
        const me = ss.state.players.find((p) => p.id === pid);
        if (ss.state.phase === 'active' && patternComplete(me.marks, ss.state.pattern)) {
          const r = await w.invoke('onPlayerMessage', ctx({ sessionState: ss, message: { from: u, data: { type: 'act', cmd: { type: 'claim' } } } }));
          if (r.value.sessionState) ss = r.value.sessionState;
          if (r.value.result) { result = r.value.result; break; }
        }
      }
    }
    assert.ok(result, 'the hall ended');
    assert.equal(result.seats.length, 4);
    const score = await w.invoke('onPlayerMessage', { now, random: 0.1, sessionId: 'p', playerStates: {}, players: [{ id: 'a', name: 'A', elo: 1200 }], sessionState: { mode: 'score' }, message: { from: 'a', data: { type: 'result', scores: { 'high-score': 1290 } } } });
    assert.deepEqual(score.value.scores, { 'high-score': { a: 1290 } });
    console.log(`# slowest invocation: ${worst} ms (budget 250)`);
    assert.ok(worst < 200, 'every invocation well inside 250 ms');
  } finally { w.close(); }
});
