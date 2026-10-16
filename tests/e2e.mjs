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
import { launchToken, stubStarHermit } from './starhermit-e2e.mjs';

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
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const step = async (name, fn) => { await fn(); console.log(`ok - [${tag}] ${name}`); };
  const base = `http://127.0.0.1:${server.address().port}/`;

  try {
    await step('load → title screen', async () => {
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])', { timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('#live-status').dataset.phase === 'title');
      await page.screenshot({ path: SHOT('title', tag) });
    });

    await step('graphics: Low → High preset, bloom override, persists across reload', async () => {
      await page.click('[data-nav="settings"]');
      await page.waitForSelector('#screen-settings:not([hidden])');
      await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
      await page.selectOption('#gfx-preset', 'low');
      await page.waitForSelector('body[data-gfx-preset="low"]');
      await page.selectOption('#gfx-preset', 'high');
      await page.waitForSelector('body[data-gfx-preset="high"]');
      if (!(await page.textContent('#gfx-summary')).includes('bloom')) throw new Error('High summary lacks bloom');
      await page.selectOption('#gfx-bloom', 'off');
      await page.waitForFunction(() => !document.querySelector('#gfx-summary').textContent.includes('bloom'));
      const panelBox = await page.locator('#gfx-panel').boundingBox();
      const vw = page.viewportSize().width;
      if (!panelBox || panelBox.x < 0 || panelBox.x + panelBox.width > vw + 1) throw new Error('graphics panel overflows viewport');
      await page.screenshot({ path: SHOT('graphics', tag) });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not([hidden])');
      await page.waitForSelector('body[data-gfx-preset="high"]');
      await page.click('[data-nav="settings"]');
      await page.waitForSelector('#screen-settings:not([hidden])');
      const kept = await page.evaluate(() => [document.querySelector('#gfx-preset').value, document.querySelector('#gfx-bloom').value]);
      if (kept[0] !== 'high' || kept[1] !== 'off') throw new Error('graphics settings not persisted: ' + kept);
      // back to Auto (software GPU → Low) so the rest of the run stays fast
      await page.selectOption('#gfx-preset', 'auto');
      await page.waitForSelector('body[data-gfx-preset="low"]');
      if ((await page.inputValue('#gfx-bloom')) !== 'preset') throw new Error('preset did not clear overrides');
      await page.click('#screen-settings [data-nav="title"]');
      await page.waitForSelector('#screen-title:not([hidden])');
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
        () => document.querySelector('#live-status').dataset.phase === 'active',
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
        () => document.querySelector('#live-status').dataset.phase === 'active',
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
          document.querySelector('#live-status').dataset.phase === 'active');
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

    await step('language: Automatic follows the StarHermit preferred language (fr-CA); Deutsch re-renders and saves ui.language; report a problem', async () => {
      const calls = await stubStarHermit(page, { preferredLanguage: 'fr-CA' });
      await page.goto('about:blank');
      await page.goto(base + 'index.html#game_token=' + launchToken(), { waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.lang === 'fr-CA', null, { timeout: 10000 });
      if ((await page.textContent('[data-nav="play-quick"]')) !== 'Jouer') throw new Error('title not in fr-CA');
      await page.click('[data-nav="settings"]');
      await page.waitForSelector('#screen-settings:not([hidden])');
      const choice = page.locator('[data-game-language="choice"]');
      if ((await choice.count()) !== 1) throw new Error('expected exactly one Language select');
      await choice.scrollIntoViewIfNeeded();
      const auto = await choice.locator('option').first().textContent();
      if (auto !== 'Automatique — Français (Canada)') throw new Error('Automatic label: ' + auto);
      await page.evaluate(() => { document.querySelector('[data-game-language="choice"]').__kept = true; });
      await choice.selectOption('de-DE');
      await page.waitForFunction(() => document.documentElement.lang === 'de-DE');
      await page.waitForFunction(() => /Im Konto gespeichert/.test(document.querySelector('[data-game-language="status"]').textContent), null, { timeout: 5000 });
      if (calls.settings['ui.language']?.choice !== 'de-DE') throw new Error('ui.language not saved: ' + JSON.stringify(calls.settings));
      const de = await page.evaluate(() => ({
        h: document.getElementById('settings-heading').textContent,
        gfx: document.getElementById('gfx-legend').textContent,
        theme: document.querySelector('select[name="theme"] option').textContent,
        done: document.querySelector('#screen-settings [data-nav="title"]').textContent,
        kept: document.querySelector('[data-game-language="choice"]').__kept === true,
      }));
      if (de.h !== 'Einstellungen' || de.gfx !== 'Grafik' || de.theme !== 'Glutenhof' || de.done !== 'Fertig' || !de.kept) throw new Error('settings not re-rendered in place: ' + JSON.stringify(de));
      await page.locator('[data-game-report="title"]').scrollIntoViewIfNeeded();
      await page.fill('[data-game-report="title"]', 'Language test report');
      await page.click('[data-game-report="send"]');
      await page.waitForFunction(() => /Danke/.test(document.querySelector('[data-game-report="status"]').textContent), null, { timeout: 5000 });
      if (!calls.reports?.[0] || calls.reports[0].kind !== 'bug') throw new Error('report not posted');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('German settings overflow horizontally');
      const fit = await page.evaluate(() => [...document.querySelectorAll('#screen-settings fieldset')].every((f) => f.getBoundingClientRect().right <= innerWidth + 1));
      if (!fit) throw new Error('a German settings fieldset is cut off');
      await page.screenshot({ path: SHOT('language-de', tag), fullPage: true });
      await page.click('#screen-settings [data-nav="title"]');
      await page.waitForSelector('#screen-title:not([hidden])');
    });

    await step('language: switching mid-round re-renders the pause dialog, HUD and card and keeps the round', async () => {
      await page.click('[data-nav="play-quick"]');
      await page.click('#setup-start');
      await page.waitForFunction(() => document.querySelector('#live-status').dataset.phase === 'active', null, { timeout: 15000 });
      const cardBefore = await page.evaluate(() => [...document.querySelectorAll('#card-grid .card-cell')].map((c) => c.textContent).join(','));
      await page.click('#btn-pause');
      await page.waitForSelector('#modal-root[open]');
      await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
      await page.waitForSelector('#screen-settings:not([hidden])');
      const choice = page.locator('[data-game-language="choice"]');
      await choice.scrollIntoViewIfNeeded();
      await choice.selectOption('it-IT');
      await page.waitForFunction(() => document.documentElement.lang === 'it-IT');
      await page.click('#screen-settings [data-nav="title"]');
      await page.waitForSelector('#modal-root[open]');
      if ((await page.textContent('#modal-title')) !== 'In pausa') throw new Error('pause dialog not Italian');
      await page.getByRole('button', { name: 'Riprendi', exact: true }).click();
      const it = await page.evaluate(() => ({
        objective: document.getElementById('objective-text').textContent,
        call: document.querySelector('#btn-call span').textContent,
        free: document.querySelector('#card-grid .card-cell.free').textContent,
        cell: document.querySelector('#card-grid .card-cell:not(.free)').getAttribute('aria-label'),
        card: [...document.querySelectorAll('#card-grid .card-cell')].map((c) => c.textContent).join(','),
        status: document.getElementById('live-status').textContent,
      }));
      if (!/^Obiettivo: /.test(it.objective) || it.call !== 'Estrai' || it.free !== 'LIBERA' || !/^riga 1 colonna 1/.test(it.cell) || !/^Turno in corso/.test(it.status)) {
        throw new Error('round not re-rendered: ' + JSON.stringify(it));
      }
      if (it.card.replace('LIBERA', 'FREE') !== cardBefore.replace('FREI', 'FREE')) throw new Error('the card changed: the round was not kept');
      await page.screenshot({ path: SHOT('language-it-play', tag) });
      await page.click('#btn-pause');
      await page.getByRole('button', { name: 'Abbandona il turno', exact: true }).click();
      await page.waitForSelector('#screen-title:not([hidden])');
      await page.click('[data-nav="settings"]');
      await choice.scrollIntoViewIfNeeded();
      await choice.selectOption('auto');
      await page.waitForFunction(() => document.documentElement.lang === 'fr-CA');
      await page.click('#screen-settings [data-nav="title"]');
      await page.unroute(/\/api\/v1\//);
    });

    if (errors.length) {
      throw new Error(`page errors in ${tag} pass:\n` + errors.join('\n'));
    }
  } finally {
    await context.close();
  }
}

/** Tall desktop, where the 3D hall is visible: play under Ultra, then switch to Low mid-round. */
async function runHallPass(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title:not([hidden])');
    await page.click('[data-nav="settings"]');
    await page.selectOption('#gfx-preset', 'ultra');
    await page.click('#screen-settings [data-nav="title"]');
    await page.click('[data-nav="play-quick"]');
    await page.click('#setup-start');
    await page.waitForFunction(() => document.querySelector('#live-status').dataset.phase === 'active', null, { timeout: 15000 });
    await page.waitForTimeout(2500);
    if (!(await page.locator('#canvas-holder canvas').isVisible())) throw new Error('3D hall not visible on tall desktop');
    await page.screenshot({ path: SHOT('hall-ultra', 'desktop') });
    await page.click('#btn-pause');
    await page.waitForSelector('#modal-root[open]');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('#screen-settings:not([hidden])');
    await page.selectOption('#gfx-preset', 'low');
    await page.waitForSelector('body[data-gfx-preset="low"]');
    await page.click('#screen-settings [data-nav="title"]');
    await page.waitForSelector('#modal-root[open]');
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: SHOT('hall-low', 'desktop') });
    if (errors.length) throw new Error('page errors in hall pass:\n' + errors.join('\n'));
    console.log('ok - [desktop-tall] 3D hall renders under Ultra and Low with no console output');
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

  await runHallPass(browser);

  console.log('\nE2E PASS — desktop + mobile playthroughs clean, no page errors');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
