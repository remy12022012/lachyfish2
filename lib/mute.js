'use strict';
// Chat mutes. A mute is one key, mute:<name>, whose value is the moment it ends (ms) and which Redis deletes by itself when the time is up,
// so a mute costs no storage beyond its own length.
const MUTE_MAX = 10080; // minutes: 7 days

// 5 -> "5 minutes", 60 -> "1 hour", 1440 -> "1 day"
function span(m) {
  if (m < 60) return m + ' minute' + (m === 1 ? '' : 's');
  if (m < 1440) { const h = Math.round(m / 60); return h + ' hour' + (h === 1 ? '' : 's'); }
  const d = Math.round(m / 1440);
  return d + ' day' + (d === 1 ? '' : 's');
}

// mins <= 0 lifts the mute.
async function setMute(store, lname, mins) {
  if (!(mins > 0)) { await store.del('mute:' + lname); return; }
  await store.set('mute:' + lname, String(Date.now() + mins * 60000), { ex: mins * 60 });
}

// Whole minutes left on a mute, 0 when the player is not muted.
async function muteLeft(store, lname) {
  const v = await store.get('mute:' + lname);
  if (!v) return 0;
  const end = +v;
  return end > Date.now() ? Math.ceil((end - Date.now()) / 60000) : 1;
}

module.exports = { MUTE_MAX, span, setMute, muteLeft };
