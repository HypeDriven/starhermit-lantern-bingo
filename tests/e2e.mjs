/**
 * Lantern Bingo — end-to-end QA playthrough (real visible UI, headless Chrome).
 *
 * Flow (desktop 1280x800, then a fresh mobile 390x844/touch context):
 *   load → title → help / settings / journey screens → Play (quick practice)
 *   → setup → countdown → active round → call/mark/claim through the real
 *   card grid and action tray (plus undo + hint in practice) → results with
 *   score breakdown → continue → second round: pause/resume/leave →
 *   hosted-play offline fallback.
 *
 * All actions go through the visible UI (clicks, touches, keys). DOM state is
 * only read for synchronization (e.g. which cells are markable, whether Claim
 * is enabled) — never to mutate the game.
 *
 * Limitation: Hosted Play requires the StarHermit authoritative server
 * (server.js), which this test deliberately does not spawn; instead it serves
 * the static build itself and verifies the client's graceful "hosted play is
 * unavailable" offline fallback. All other modes run fully locally.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'text/typescript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// benign GPU/swiftshader console noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|swiftshader/i;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = path.normalize(decodeURIComponent(url.pathname));
  if (p === '/' || p === '\\') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || p.includes('..')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const SHOT = (stage, tag) => `/tmp/lantern-bingo-e2e-${stage}-${tag}.png`;
const screenVisible = (page, name) =>
  page.$eval(`#screen-${name}`, (el) => !el.hidden).catch(() => false);

/** Drive a round through the visible card UI until the results screen shows. */
async function playRoundToResults(page, tag, { exerciseUndo = false } = {}) {
  const tap = (sel) => page.click(sel, { timeout: 1500 }).catch(() => {});
  let undoDone = !exerciseUndo;
  let shotTaken = false;
  let calls = 0;
  for (let i = 0; i < 140; i++) {
    if (await screenVisible(page, 'results')) return;
    if (!(await screenVisible(page, 'play'))) { await page.waitForTimeout(200); continue; }

    // mark every callable cell through the real grid buttons
    const cells = await page.$$eval('#card-grid .card-cell.markable',
      (els) => els.map((el) => el.dataset.cell));
    for (const c of cells) await tap(`#card-grid .card-cell[data-cell="${c}"]`);
    if (cells.length && !shotTaken) { await page.screenshot({ path: SHOT('play', tag) }); shotTaken = true; }

    // practice mode: exercise the Undo tray button once, mid-round
    if (cells.length && !undoDone && await page.locator('#btn-undo').isVisible()) {
      const before = await page.$$eval('#card-grid .card-cell.marked', (els) => els.length);
      await tap('#btn-undo');
      const after = await page.$$eval('#card-grid .card-cell.marked', (els) => els.length);
      if (after !== before - 1) throw new Error(`undo did not revert one mark (${before} -> ${after})`);
      console.log('  undo reverted one mark');
      undoDone = true;
      // re-mark the reverted cell so the round can still be won
      const again = await page.$$eval('#card-grid .card-cell.markable', (els) => els.map((el) => el.dataset.cell));
      for (const c of again) await tap(`#card-grid .card-cell[data-cell="${c}"]`);
    }

    // the round can end (win or a bot claims first) at any moment — the loop
    // re-checks for the results screen on every iteration
    const claimEnabled = await page.$eval('#btn-claim', (b) => !b.disabled);
    if (claimEnabled) await tap('#btn-claim');
    else { await tap('#btn-call'); calls++; }
    await page.waitForTimeout(140);
  }
  if (!(await screenVisible(page, 'results'))) {
    throw new Error(`round did not reach results after ${calls} manual calls`);
  }
}

async function verifyResults(page, tag) {
  const body = await page.textContent('#results-body');
  for (const needle of ['Pattern bonus', 'Total', 'Ranking']) {
    if (!body.includes(needle)) throw new Error(`results missing "${needle}"`);
  }
  if (!/Hash [0-9a-f]{8}/.test(body)) throw new Error('results missing state hash');
  const headline = await page.locator('#results-body h3').textContent();
  console.log('  outcome:', headline.trim());
  await page.screenshot({ path: SHOT('results', tag) });
  const played = await page.evaluate(() =>
    JSON.parse(JSON.parse(localStorage.getItem('lantern-bingo-v1')).payload).progress.gamesPlayed);
  if (!(played >= 1)) throw new Error('gamesPlayed not persisted');
  console.log('  gamesPlayed persisted:', played);
}

async function runPass(browser, tag, viewport, opts = {}) {
  const context = await browser.newContext({ viewport, ...opts });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const step = async (name, fn) => { await fn(); console.log(`ok - [${tag}] ${name}`); };
  const base = `http://127.0.0.1:${server.address().port}/`;

  try {
    await step('load → title screen', async () => {
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('#live-status').textContent.includes('title'));
      await page.screenshot({ path: SHOT('title', tag) });
    });

    if (tag === 'desktop') {
      await step('help screen opens and closes', async () => {
        await page.click('[data-nav="help"]');
        await page.waitForSelector('#screen-help:not([hidden])');
        await page.screenshot({ path: SHOT('help', tag) });
        await page.click('#screen-help [data-nav="title"]');
        await page.waitForSelector('#screen-title:not([hidden])');
      });

      await step('settings open → change theme/contrast → done', async () => {
        await page.click('[data-nav="settings"]');
        await page.waitForSelector('#screen-settings:not([hidden])');
        await page.selectOption('#settings-form select[name="theme"]', 'jade');
        await page.check('#settings-form input[name="highContrast"]');
        const applied = await page.evaluate(() => ({
          contrast: document.body.classList.contains('high-contrast'),
          saved: JSON.parse(JSON.parse(localStorage.getItem('lantern-bingo-v1')).payload).settings.theme,
        }));
        if (!applied.contrast || applied.saved !== 'jade') {
          throw new Error('settings not applied: ' + JSON.stringify(applied));
        }
        await page.screenshot({ path: SHOT('settings', tag) });
        await page.click('#screen-settings [data-nav="title"]');
        await page.waitForSelector('#screen-title:not([hidden])');
      });

      await step('journey screen lists stages with stage 1 unlocked', async () => {
        await page.click('[data-nav="journey"]');
        await page.waitForSelector('#screen-journey:not([hidden])');
        const total = await page.locator('#journey-list li button').count();
        const locked = await page.locator('#journey-list li button.locked').count();
        if (total < 5) throw new Error(`expected journey stages, got ${total}`);
        if (locked >= total) throw new Error('no unlocked journey stage');
        console.log(`  journey stages: ${total}, locked: ${locked}`);
        await page.screenshot({ path: SHOT('journey', tag) });
        await page.click('#screen-journey [data-nav="title"]');
        await page.waitForSelector('#screen-title:not([hidden])');
      });
    }

    await step('Play → setup screen describes the round', async () => {
      await page.click('[data-nav="play-quick"]');
      await page.waitForSelector('#screen-setup:not([hidden])');
      const details = await page.textContent('#setup-details');
      if (!details.includes('Pattern') || !details.includes('Unranked')) {
        throw new Error('setup screen missing rules summary');
      }
      await page.screenshot({ path: SHOT('setup', tag) });
    });

    await step('start → countdown → active round with 25-cell card', async () => {
      await page.click('#setup-start');
      await page.waitForSelector('#screen-play:not([hidden])');
      await page.waitForFunction(
        () => document.querySelector('#live-status').textContent.includes('active'),
        null, { timeout: 12000 });
      const cells = await page.locator('#card-grid .card-cell').count();
      if (cells !== 25) throw new Error(`expected 25 card cells, got ${cells}`);
      const call = await page.textContent('#call-display');
      console.log('  first call display:', call.trim());
    });

    await step('play round to results via card clicks + call/claim buttons', async () => {
      await playRoundToResults(page, tag, { exerciseUndo: tag === 'desktop' });
    });

    await step('results show breakdown, ranking, hash; progress persisted', async () => {
      await verifyResults(page, tag);
    });

    await step('continue → back to title', async () => {
      await page.click('#results-next');
      await page.waitForSelector('#screen-title:not([hidden])');
    });

    await step('second round: hint, pause/resume, leave', async () => {
      await page.click('[data-nav="play-quick"]');
      await page.click('#setup-start');
      await page.waitForFunction(
        () => document.querySelector('#live-status').textContent.includes('active'),
        null, { timeout: 12000 });
      await page.click('#btn-hint');
      const hint = await page.textContent('#hint-text');
      if (!hint.trim()) throw new Error('hint produced no text');
      console.log('  hint:', hint.trim());
      await page.click('#btn-pause');
      await page.waitForSelector('#modal-root[open]');
      const modalTitle = await page.textContent('#modal-title');
      if (modalTitle !== 'Paused') throw new Error('pause modal not shown');
      await page.screenshot({ path: SHOT('pause', tag) });
      await page.getByRole('button', { name: 'Resume' }).click();
      await page.waitForFunction(
        () => !document.querySelector('#modal-root').open &&
          document.querySelector('#live-status').textContent.includes('active'));
      await page.click('#btn-pause');
      await page.waitForSelector('#modal-root[open]');
      await page.getByRole('button', { name: 'Leave round' }).click();
      await page.waitForSelector('#screen-title:not([hidden])');
    });

    if (tag === 'desktop') {
      await step('hosted play falls back gracefully without a hall server', async () => {
        await page.click('[data-nav="hosted"]');
        await page.waitForFunction(
          () => document.querySelector('#live-status').textContent.includes('unavailable'),
          null, { timeout: 10000 });
        await page.screenshot({ path: SHOT('hosted-offline', tag) });
        // the rejected /ws handshake is the expected signal of this offline
        // fallback, not a defect — drop it from the collected page errors
        for (let i = errors.length - 1; i >= 0; i--) {
          if (/WebSocket connection to 'ws:\/\/[^']+\/ws' failed/.test(errors[i])) errors.splice(i, 1);
        }
      });
    }

    if (errors.length) {
      throw new Error(`page errors in ${tag} pass:\n` + errors.join('\n'));
    }
  } finally {
    await context.close();
  }
}

let browser = null;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  await runPass(browser, 'desktop', { width: 1280, height: 800 });
  await runPass(browser, 'mobile', { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

  console.log('\nE2E PASS — desktop + mobile playthroughs clean, no page errors');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
