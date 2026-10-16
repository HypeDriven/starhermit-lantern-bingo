'use strict';

// Lantern Bingo — cloud-save conflict merge (DOM-free, unit-tested).
// Another device saved since this one last loaded the slot: keep everything
// either side earned (journey stages, lessons, achievements with the earliest
// unlock time, play days, the best score per stage and per day, the larger
// round count) and this device's settings.
export function mergeSaves(remote, local, base) {
  const r = { ...base.progress, ...((remote && remote.progress) || {}) };
  const l = { ...base.progress, ...((local && local.progress) || {}) };
  const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const maxMap = (a, b) => {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) out[k] = Math.max(Number(out[k]) || 0, Number(v) || 0);
    return out;
  };
  const achievements = { ...(r.achievements || {}) };
  for (const [k, v] of Object.entries(l.achievements || {})) achievements[k] = achievements[k] && achievements[k] < v ? achievements[k] : v;
  return {
    ...base, ...(remote || {}), ...(local || {}), version: 1,
    settings: { ...base.settings, ...((remote && remote.settings) || {}), ...((local && local.settings) || {}) },
    progress: {
      ...r, ...l,
      journeyDone: union(r.journeyDone, l.journeyDone), lessonsDone: union(r.lessonsDone, l.lessonsDone),
      streakDays: union(r.streakDays, l.streakDays), achievements,
      bestScores: maxMap(r.bestScores, l.bestScores), dailyHistory: maxMap(r.dailyHistory, l.dailyHistory),
      gamesPlayed: Math.max(Number(r.gamesPlayed) || 0, Number(l.gamesPlayed) || 0),
    },
  };
}
