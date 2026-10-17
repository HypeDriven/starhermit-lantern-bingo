// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Quick Play round and keeps playing through the visible card (mark callable cells, Call,
// Claim), so the 3D hall's call ball, lanterns, motes and card tiles animate. A finished round goes
// back to the title through Continue and a new round is started.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const shown = (page, name) => page.$eval(`#screen-${name}`, (el) => !el.hidden).catch(() => false);

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title:not([hidden])', { timeout: 20000 });
  await page.click('[data-nav="settings"]');
  await page.waitForSelector('#screen-settings:not([hidden])');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForSelector(`body[data-gfx-preset="${preset}"]`);
  await page.click('#screen-settings [data-nav="title"]');
  await page.waitForSelector('#screen-title:not([hidden])');
}

async function launch(page) {
  await page.click('[data-nav="play-quick"]');
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.click('#setup-start');
  await page.waitForSelector('#screen-play:not([hidden])');
}

export async function start(page) {
  await launch(page);
  let stopped = false;
  page.once('close', () => { stopped = true; });
  const tap = (sel) => page.click(sel, { timeout: 1000 }).catch(() => {});
  (async () => {
    while (!stopped) {
      try {
        if (await shown(page, 'results')) {
          await page.click('#results-next', { timeout: 1000 });
          await page.waitForSelector('#screen-title:not([hidden])', { timeout: 5000 });
          await launch(page);
        } else if (await shown(page, 'play')) {
          const cells = await page.$$eval('#card-grid .card-cell.markable', (els) => els.map((el) => el.dataset.cell));
          for (const c of cells) await tap(`#card-grid .card-cell[data-cell="${c}"]`);
          const claim = await page.$eval('#btn-claim', (b) => !b.disabled).catch(() => false);
          await tap(claim ? '#btn-claim' : '#btn-call');
        }
      } catch { /* screen changing */ }
      await new Promise((r) => setTimeout(r, 600));
    }
  })();
  await page.waitForFunction(() => document.querySelector('#live-status')?.dataset.phase === 'active', null, { timeout: 15000 }).catch(() => {});
}
