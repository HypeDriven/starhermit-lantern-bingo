// Key extraction for the i18n coverage test (run directly to list the keys).
// Keys are the US-English source strings: literal T('…') / N('…') calls and
// T(...) template keys in js/, data-i18n* markup in index.html (rich-text
// paragraphs use their authored innerHTML), the content tables' display fields
// (patterns, lessons, challenges, themes) and the audio captions.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATTERNS } from '../js/rules.js';
import { CHALLENGES, LESSONS, THEMES } from '../js/content.js';

const ROOT = new URL('..', import.meta.url).pathname;
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');
const unhtml = (s) => s.replace(/&amp;/g, '&');

export function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w.$])(?:T|N|setStatus|announce)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of readdirSync(join(ROOT, 'js'))) {
    if (!f.endsWith('.js') || f === 'i18n.js') continue;
    const src = readFileSync(join(ROOT, 'js', f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    // ternaries inside T(cond ? 'a' : 'b', …)
    for (const m of src.matchAll(/T\([^'"()]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) { keys.add(m[1]); keys.add(m[2]); }
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(unhtml(m[1]));
  for (const m of html.matchAll(/<p data-i18n-html>([\s\S]*?)<\/p>/g)) keys.add(m[1].trim());
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const p of Object.values(PATTERNS)) add(p.name, p.desc);
  for (const l of LESSONS) { add(l.title); for (const s of l.steps) add(s.text); }
  for (const c of CHALLENGES) add(c.title, c.constraint);
  for (const t of THEMES) add(t.name);
  const audio = readFileSync(join(ROOT, 'js/audio.js'), 'utf8');
  for (const m of audio.matchAll(/_caption\('([^']+)'\)/g)) add(m[1]);
  const caps = audio.slice(audio.indexOf('SFX_CAPTIONS = {'), audio.indexOf('};', audio.indexOf('SFX_CAPTIONS = {')));
  for (const m of caps.matchAll(/: '([^']+)'/g)) add(m[1]);
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);

if (process.argv[1] && process.argv[1].endsWith('i18n-keys.mjs')) console.log(JSON.stringify([...ALL], null, 1));
