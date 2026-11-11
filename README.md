# Lachy Fish: Vercel deployment

The game is one static page (`public/index.html`) plus six serverless functions in `api/` that power accounts, cloud saves, the global leaderboard, player profiles and the activity feed. Data lives in **Upstash Redis**, the standard persistent store for Vercel (serverless functions cannot keep data in memory between requests).

## Deploy (about 5 minutes)

1. **Create the project.** Either push this folder to a GitHub repo and import it at vercel.com/new, or run `npx vercel` in this folder. Leave every build setting alone; `vercel.json` already sets them (no framework, no build, output `public/`).
2. **Add the database.** In the Vercel dashboard open your project, go to **Storage** (or the Marketplace), add **Upstash for Redis** (the free plan is plenty) and connect it to the project for all environments. This adds the environment variables `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (older integrations name them `KV_REST_API_URL` and `KV_REST_API_TOKEN`; both work). Pick the database region closest to your Vercel functions region.
3. **Set up admin codes (optional but recommended).** Run `node scripts/gen-admin-codes.js 3 1` on your computer (3 staff codes and 1 owner code), give each code to one person, and put the printed `ADMIN_CODES` line, which holds only hashes, into the project's **Settings, Environment Variables**. See *Admin codes* below. Without it, `/api/admin` answers 503 and the in-game admin tools do nothing.
4. **Redeploy.** Environment variables only apply to new deployments: Deployments, then the latest one, then Redeploy (or `npx vercel --prod`).
5. **Check it.** Open `https://YOUR-SITE/api/leaderboard`. You should see `{"rows":[],"total":0,"me":null}`. If you see `The server database is not connected yet.` the variables from step 2 are missing from that deployment.

Then open the game, go to the **Top** tab, sign up, and your account appears on the board. Play on a second device, log in, and **Load cloud save** brings your progress across.

## What the server does

| Endpoint | Purpose |
| --- | --- |
| `POST /api/signup`, `POST /api/login` | Accounts. Passwords are hashed with scrypt; sessions are random 256-bit tokens kept 90 days. Signup is limited to 10 per hour and 25 per day per IP, and 400 per hour across the whole site. |
| `POST /api/password` | Any signed-in player changes their own password. Body `{oldPassword, newPassword}` (6-72 characters, different from the old one). A wrong old password answers 403 (not 401, so the game does not sign the player out). Limited to 5 tries per 15 minutes per account and 20 per IP. On success every other session is ended and a fresh token is returned for the current device. In the game: **Top** tab, **Change password**. |
| `GET /api/me` | Your rank and cloud save. |
| `POST /api/submit` | The game syncs money, income, ascensions, book, best faces and the cloud save (every 30 s while signed in, or **Sync now**). |
| `GET /api/leaderboard?view=peak\|inc\|asc\|book` | Top 50 for each board, your rank, and the activity feed. |
| `GET /api/leaderboard?u=NAME` | A player's profile. |
| `POST /api/admin` | Signed-in accounts only: send your normal session token (`Authorization: Bearer ...`) and a body `{action, username}`. There is no admin password. `redeem` (body `{action: "redeem", code}`) turns your account into an admin, `status` answers `{admin, tier}`. Staff can use `kick` (ends every existing session; the player can sign in again), `ban` (blocks sessions and login, removes them from the boards), `unban`, `reset` (deletes stats and cloud save, keeps the account, removes them from the boards), `quarantine`, `unflag` and `flags`. Owners can also use `revoke` (ends a staff admin) and `wipeall` (no username; needs `confirm: "DELETE ALL ACCOUNTS"`; deletes EVERY other account, cloud save, session, ban, leaderboard and the activity feed, keeps the calling owner's own account, and cannot be undone; it works in batches, so if it answers `done: false` just send it again until it says `done: true`). A non-admin gets 403, and admins cannot act on other admins (an owner may act on staff). Wrong codes are limited to 5 per 15 minutes per IP and per account, and all admin requests to 60 per 10 minutes per IP. |

Protections: strict input validation (invalid numbers are rejected with 422), peak money and ascensions can never go down, ascensions are capped at 20 and can rise by at most 2 per sync (a new account counts as 0), stats or cloud saves that contain a rarity the ascension count has not unlocked are rejected, requests from an old season are refused with 409, one sync per 5 s per player, login and signup rate limits, constant-time password checks, identical errors for unknown user and wrong password, usernames limited to letters, numbers and `_ . -` (3 to 16 characters). The game runs in the player's browser, so a determined cheater can still fake numbers; the limits stop casual abuse, not a skilled attacker.

If the database is missing on Vercel, the API answers 503 with a clear message instead of silently losing data, and the game keeps working offline with its normal local saves.

### Anti-cheat

The server cannot replay the game, so it checks that what the client sends is *possible* (`lib/cheat.js`). Every sync must carry a valid cloud save, and the stats are compared with that save and with the time since the last accepted sync.

* **Hard findings** are impossible states: an upgrade above its maximum, a face above level 20, more faces or crew than the base and slots allow, malformed Book entries, gems above the ceiling, income or cast rate far above what the faces in the save could produce, or a huge jump in coins. The sync is rejected (422 `Invalid stats.`) and the account gets a **strike**. Three strikes within 24 hours **quarantine** the account: it keeps playing and syncing, but is removed from every leaderboard until an admin clears it.
* **Soft findings** are suspicious but possible, for example stats that do not match the save they came with, or coins, catches or gems growing faster than real time allows (playing on another device while logged out can cause this). The sync is rejected with a hint to wait and try again, and **no strike** is counted.
* The economy tables in `lib/cheat.js` must match `RAR`, `MUT` and `UPS` in `public/index.html`; `npm test` fails if they drift apart.
* Admin actions (for staff and owner admins, see the admin row above): `flags` (no username; lists recent flagged syncs and each account's strikes and quarantine state), `quarantine` (hide an account from the boards by hand), `unflag` (clear the quarantine and strikes). `reset` and `wipeall` also clear them.
* The game also ignores a daily reward whose day is not later than the last claim, and gives no offline earnings when the saved timestamp is in the future (clock turned back).
* Limits: coins and income are still computed on the player's device, so these checks raise the bar but cannot make cheating impossible.

Keys used: `q:<name>` quarantine, `strikes:<name>` strike counter (expires after 24 h), `flagfeed` recent findings.

### Admin from the game

Tap the small rock in the bottom-left corner of the seabed 5 times quickly (or tap the coin counter 7 times, or press the backtick key 3 times) to open the hidden dev panel. Its **Server admin** section lets a signed-in account paste an admin code. Once the account is an admin the section shows the moderation buttons (kick, ban, unban, reset, quarantine, unflag, show flags, and for owners revoke and the wipe). No password is typed. The panel's client-only cheats are separate, run locally, and switch on a test mode that blocks leaderboard and cloud sync for that device.

### Admin codes

There is no shared admin password. Admins are ordinary player accounts that redeemed a one-time code, so you can hand a few people a code without the risk of one shared password leaking.

* **Make codes:** `node scripts/gen-admin-codes.js [staff=3] [owner=0]` prints each code (160 random bits) and an `ADMIN_CODES` line. Give each code to one person. Set `ADMIN_CODES` in Vercel (Settings, Environment Variables) and redeploy. It holds only SHA-256 hashes (separated by commas, spaces or new lines; start an entry with `owner:` for the owner tier), so nothing secret is in the repo, the page or the database.
* **Redeem:** the person signs in, opens the dev panel (it has its own access password) and pastes the code under **Server admin**. The first account to redeem a code becomes an admin for good. The code is then spent and cannot be bound to a second account, so a code that leaks after use is useless. Case, spaces and dashes are ignored.
* **Tiers:** staff can kick, ban, unban, reset, quarantine, unflag and read the flags. Owners can also revoke a staff admin and run `wipeall` (which keeps the owner's own account). Admins cannot act on other admins, except an owner on staff, so a leaked staff code cannot be used against the owner.
* **Revoke:** remove the hash from `ADMIN_CODES` and redeploy (that admin stops working at once; putting the hash back restores it), or let an owner use `revoke` on a staff admin (the code stays spent). Owner codes can only be revoked by removing them from `ADMIN_CODES`.
* **Account binding:** an admin record is tied to the account's creation time, so a name that is registered again after a wipe does not inherit admin.
* **Limits:** 5 wrong codes per 15 minutes per IP and per account (real admins are never counted), and 60 admin requests per 10 minutes per IP.
* Keys used: `ac:<hash>` spent code, `adm:<name>` admin binding. `wipeall` leaves both alone.

## Ascensions and seasons

* **Maximum ascension is 20.** The server rejects more, and the game stops offering Ascend at 20.
* **Ascending costs cash.** The next ascension needs `2e8 * 3.4^n` coins in hand (n = ascensions so far, so $200M, then $680M, and so on up to about $2.4 quintillion for the 20th). The run is wiped on ascending, so the money is spent. There are no Pearls any more. The server also requires 10 real minutes per ascension gained (counted from account creation or the last ascension, `MIN_ASC_MS` in `lib/util.js`), so a tampered client cannot claim a pile of ascensions at once.
* **Every high rarity has its own ascension requirement** (`ASC_REQ` in `lib/util.js` and `public/index.html`; keep the two in sync). Below its requirement a rarity has zero chance and cannot be fused into: Exotic 3, Celestial 5, Cosmic 7, Eternal 9, Omega 11, Nebula 13, **Quantum 17, Abyssal 19, ULTRA 20, Limited Edition 20**. Quantum and Abyssal ramp up over the ascensions after they unlock; ULTRA and the Limited Edition only unlock at the maximum, so they only ever drop at ascension 20.
* **Seasons.** `SEASON` (in `lib/util.js` and `public/index.html`) is stamped into every save and every sync. A browser save from another season is discarded on load (the player starts fresh) and the server answers 409 to an old cached copy of the game, so exploited saves and old tabs cannot sync back after a reset. Bump `SEASON` whenever you reset progress again.
* **Resetting everyone:** deploy, then use an owner admin's **Wipe all accounts** button in the dev panel (see Admin codes), or call it directly: `curl -X POST https://YOUR-SITE/api/admin -H 'Authorization: Bearer OWNER_TOKEN' -d '{"action":"wipeall","confirm":"DELETE ALL ACCOUNTS"}'`. It keeps the owner's own account and deletes every other account, save, session and board.

## Update notices

Open tabs find out when a new version is live, so players do not keep playing an old copy.

* **Build id.** Every deploy gets a 12-character id: a hash of `public/index.html` and every file in `api/` and `lib/` (`lib/build.js`). On Vercel the build command (`node scripts/build-id.js`, set in `vercel.json`) stamps it into the page (replacing the `__BUILD_ID__` placeholder, which is why the source page keeps the placeholder), into `public/version.json` and into `lib/buildid.json` (bundled with the API functions). Outside Vercel the script does nothing unless you pass `--force`, so it cannot overwrite the source page by accident. `dev.js` computes the id on the fly and serves `/version.json` and the stamped page itself.
* **Soft update.** The page checks `version.json` every minute, when the tab regains focus and 5 seconds after loading, and also reads the `build` returned by every successful `/api/submit`. If it differs from the page's own build, a banner offers **Update now** or **Later** (Later hides it for 15 minutes). Update now saves the game locally, pushes one last sync, then reloads.
* **Required update.** If `version.json` reports another `SEASON`, or the server answers 409 (`required: true`), a full-screen box asks for a reload and the old page stops syncing. The local save is kept, and the new page loads it as usual unless the season changed.
* **Caching.** `/`, `/index.html` and `/version.json` are served with `no-cache` / `no-store` headers (`vercel.json`), so a reload always fetches the new page.
* An unstamped page (opened straight from the file, or a build that could not stamp) never claims to be out of date.

## Local development

```
npm install
npm run dev     # http://localhost:3000 with an in-memory store (data resets on restart)
npm test        # API test suite
```

To develop against a real database, export `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` first. `vercel dev` also works.

## Operations

* Moderation: use the admin actions above (in the game's dev panel, or with `curl -X POST https://YOUR-SITE/api/admin -H 'Authorization: Bearer ADMIN_TOKEN' -d '{"action":"ban","username":"NAME"}'`). For manual work, open the database's Data Browser in Upstash. Keys: `u:<name>` account, `p:<name>` stats, `sv:<name>` cloud save, `lb:peak|inc|asc|book` boards, `feed` activity, `s:<hash>` sessions (value `name|loginTime`), `kick:<name>` and `ban:<name>` moderation markers, `adm:<name>` and `ac:<hash>` admin bindings, `rl:*` rate limits.
* Cost: one sync is about 10 Redis commands, so even a few hundred active players stay inside the free tier.
