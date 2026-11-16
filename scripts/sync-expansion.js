'use strict';
// Copies the expansion tables from lib/expansion.js into the marked region of public/index.html, so the client and server can never disagree.
// node scripts/sync-expansion.js         rewrites the region
// node scripts/sync-expansion.js --check exits 1 when the page is out of date (used by the tests)
const fs = require('fs'), path = require('path'), x = require('../lib/expansion');
const file = path.join(__dirname, '..', 'public', 'index.html');
const tables = () => 'var XT=' + JSON.stringify({ slot: x.SLOT_MS, chance: x.EVENT_CHANCE, events: x.EVENTS, rods: x.RODS, locs: x.LOCATIONS, mastery: { max: x.MASTERY_MAX_LV, cash: x.MASTERY_CASH, xp: x.MASTERY_XP }, chestMax: x.CHEST_MAX, level: { max: x.LEVEL_MAX, cash: x.LEVEL_CASH, luck: x.LEVEL_LUCK }, titles: x.LEVEL_TITLES, ach: x.XACH, tiers: x.CHEST_TIERS, evo: { max: x.EVO_MAX, cash: x.EVO_CASH, luck: x.EVO_LUCK, matMax: x.MAT_MAX }, mats: x.MATERIALS, excChance: x.EXC_CHANCE, museum: { cases: x.MUSEUM_CASES, minRar: x.MUSEUM_MIN_RAR, pins: x.MUSEUM_PINS, themes: x.MUSEUM_THEMES }, book: { total: x.BOOK_TOTAL, goals: x.BOOK_GOALS }, tn: { ms: x.TOURNEY_MS, keep: x.TOURNEY_KEEP_S, claim: x.TOURNEY_CLAIM_WINDOWS, ptsMax: x.TOURNEY_PTS_MAX, winMax: x.TOURNEY_WIN_MAX, cats: x.TOURNEY_CATS, rewards: x.TOURNEY_REWARDS } }) + ';';
const RE = /\/\*X:TABLES\*\/[\s\S]*?\/\*X:END\*\//;
const html = fs.readFileSync(file, 'utf8');
if (!RE.test(html)) { console.error('expansion markers are missing from public/index.html'); process.exit(1); }
const next = html.replace(RE, () => '/*X:TABLES*/' + tables() + '/*X:END*/');
if (process.argv.includes('--check')) process.exit(next === html ? 0 : 1);
fs.writeFileSync(file, next);
console.log('expansion tables synced');
