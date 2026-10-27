// Key extraction for the i18n coverage test (run directly to list the keys).
// Keys are the US-English source strings: literal T("…") / N("…") calls (and
// announce / setStatus / setHint, which translate their key) in native/*.ts
// and js/*.js, ternaries inside T(), the content tables' display fields
// (patterns, lessons, challenges, themes) and the audio captions.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATTERNS } from '../js/rules.js';
import { CHALLENGES, LESSONS, THEMES } from '../js/content.js';

const ROOT = new URL('..', import.meta.url).pathname;
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w.$])(?:T|N|setStatus|announce|setHint)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const files = [
    ...readdirSync(join(ROOT, 'native')).filter((f) => f.endsWith('.ts')).map((f) => join(ROOT, 'native', f)),
    ...readdirSync(join(ROOT, 'js')).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => join(ROOT, 'js', f)),
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(/T\([^'"()]*\?\s*(['"])([^'"]+)\1\s*:\s*(['"])([^'"]+)\3/g)) { keys.add(m[2]); keys.add(m[4]); }
  }
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const p of Object.values(PATTERNS)) add(p.name, p.desc);
  for (const l of LESSONS) { add(l.title); for (const s of l.steps) add(s.text); }
  for (const c of CHALLENGES) add(c.title, c.constraint);
  for (const t of THEMES) add(t.name);
  const audio = readFileSync(join(ROOT, 'native/audio.ts'), 'utf8');
  const caps = audio.slice(audio.indexOf('CAPTIONS'), audio.indexOf('};', audio.indexOf('CAPTIONS')));
  for (const m of caps.matchAll(/: "([^"]+)"/g)) add(m[1]);
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);

if (process.argv[1] && process.argv[1].endsWith('i18n-keys.mjs')) console.log(JSON.stringify([...ALL], null, 1));
