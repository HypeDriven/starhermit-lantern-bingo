// Targeted checks for review fixes, against the real server on :9377.
import { chromium } from 'playwright-core';

const base = `http://127.0.0.1:${process.env.SMOKE_PORT}/`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|GL Driver|swiftshader|GPU stall/i.test(m.text())) errors.push('console: ' + m.text()); });

try {
await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('#screen-title:not([hidden])');

// --- 1. pause during countdown ---
await page.click('[data-nav="play-quick"]');
await page.click('#setup-start');
await page.waitForSelector('#screen-play:not([hidden])');
await page.keyboard.press('p'); // during countdown
await page.waitForTimeout(300);
check('pause during countdown opens modal', await page.$eval('#modal-root', (d) => d.open));
await page.getByRole('button', { name: 'Resume' }).click();
check('resume preserves unfinished countdown', await page.locator('.countdown-num').count() === 1 && !(await page.textContent('#live-status')).includes('active'));
await page.waitForFunction(() => document.querySelector('#live-status').textContent.includes('active'), null, { timeout: 12000 });
check('round reaches active after countdown resume', true);

// --- 2. FREE center cell never penalizes ---
const invalidBefore = await page.evaluate(() => document.querySelector('#score-preview').textContent);
await page.keyboard.press('Enter'); // focus starts on CENTER
await page.waitForTimeout(200);
const invalidAfter = await page.evaluate(() => document.querySelector('#score-preview').textContent);
check('FREE cell Enter causes no invalid penalty', invalidBefore === invalidAfter, invalidAfter);

// --- 3. pause → settings → Done returns to pause, round intact ---
await page.click('#btn-pause');
await page.waitForSelector('#modal-root[open]');
await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForSelector('#screen-settings:not([hidden])');
await page.click('#screen-settings [data-nav="title"]');
await page.waitForTimeout(300);
const backAtPause = await page.$eval('#modal-root', (d) => d.open && document.querySelector('#modal-title').textContent === 'Paused');
check('settings Done from pause reopens pause modal', backAtPause);
const stillPlaying = await page.evaluate(() => !document.querySelector('#screen-play').hidden || document.querySelector('#modal-root').open);
check('round not abandoned by settings Done', stillPlaying);

// --- 4. pause → help → Back returns to pause ---
await page.getByRole('button', { name: 'Help' }).click();
await page.waitForSelector('#screen-help:not([hidden])');
await page.click('#screen-help [data-nav="title"]');
await page.waitForTimeout(300);
check('help Back from pause reopens pause modal', await page.$eval('#modal-root', (d) => d.open && document.querySelector('#modal-title').textContent === 'Paused'));
// Escape from help also returns (leave via modal first)
await page.getByRole('button', { name: 'Help' }).click();
await page.waitForSelector('#screen-help:not([hidden])');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape from pause-help reopens pause modal', await page.$eval('#modal-root', (d) => d.open && document.querySelector('#modal-title').textContent === 'Paused'));
await page.getByRole('button', { name: 'Leave round' }).click();
await page.waitForSelector('#screen-title:not([hidden])');

// --- 5. hosted round against the real server ---
await page.click('[data-nav="hosted"]');
await page.waitForFunction(() => document.querySelector('#live-status').textContent.includes('hosted'), null, { timeout: 10000 });
const hosted = await page.evaluate(() => ({
  cells: document.querySelectorAll('#card-grid .card-cell').length,
  callDisabled: document.querySelector('#btn-call').disabled,
  undoHidden: document.querySelector('#btn-undo').hidden,
}));
check('hosted round shows 25-cell card, call disabled, undo hidden',
  hosted.cells === 25 && hosted.callDisabled && hosted.undoHidden, JSON.stringify(hosted));
// wait for server calls and try marking own card + Enter key (facade must not throw)
await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#call-display').textContent), null, { timeout: 12000 });
await page.keyboard.press('Enter'); // center cell — must not throw
await page.waitForTimeout(300);
const marked = await page.$$eval('#card-grid .card-cell.markable', (els) => els.map((el) => el.dataset.cell));
for (const c of marked.slice(0, 3)) await page.click(`#card-grid .card-cell[data-cell="${c}"]`).catch(() => {});
check('no page errors during hosted marking', errors.length === 0, errors.join(' | ').slice(0, 200));
// pause + resume in hosted mode (scheduleBots/dispatch guard)
await page.click('#btn-pause');
await page.waitForSelector('#modal-root[open]');
await page.getByRole('button', { name: 'Resume' }).click();
await page.waitForTimeout(2500); // bot timers would have fired by now if misscheduled
check('no page errors after hosted pause/resume', errors.length === 0, errors.join(' | ').slice(0, 200));
// leave hosted round
await page.click('#btn-pause');
await page.waitForSelector('#modal-root[open]');
await page.getByRole('button', { name: 'Leave round' }).click();
await page.waitForSelector('#screen-title:not([hidden])');

// --- 6. practice after hosted: Call button re-enabled ---
await page.click('[data-nav="play-quick"]');
await page.click('#setup-start');
await page.waitForFunction(() => document.querySelector('#live-status').textContent.includes('active'), null, { timeout: 12000 });
check('call button re-enabled after hosted round', await page.$eval('#btn-call', (b) => !b.disabled));
await page.click('#btn-call');
await page.waitForTimeout(300);
check('manual call works after hosted round', /^\d+$/.test(await page.textContent('#call-display')));

check('zero page errors overall', errors.length === 0, errors.join(' | ').slice(0, 300));

} finally {
  await browser.close();
}
const failed = results.filter((r) => !r[1]).length;
console.log(failed ? failed + ' FIX-CHECK FAILURES' : 'ALL FIX CHECKS PASSED');
process.exit(failed ? 1 : 0);
