import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
for (const script of ['ws-smoke.mjs', 'review-fixes.mjs']) {
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/localhost:(\d+)/);
      if (match) resolve(match[1]);
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Server exited: ' + code)));
  });
  {
    const child = spawn(process.execPath, ['tests/' + script], { cwd: root, env: { ...process.env, SMOKE_PORT: port }, stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, script);
  }
} finally {
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
}
}
