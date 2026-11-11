'use strict';
// Build id: a short hash of the client page plus every server file. It changes whenever a deploy changes anything players
// could notice, so open tabs can tell they are out of date. scripts/build-id.js stamps it into public/index.html (replacing the
// placeholder), public/version.json and lib/buildid.json at build time; in local development it is computed on the fly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PLACEHOLDER = '__BUILD_ID__';
const INDEX = path.join(ROOT, 'public', 'index.html');
const STAMP = path.join(__dirname, 'buildid.json');

function sourceFiles() {
  const files = [INDEX];
  for (const dir of ['api', 'lib']) {
    let names = [];
    try { names = fs.readdirSync(path.join(ROOT, dir)); } catch (e) { /* missing folder */ }
    for (const n of names.sort()) if (n.endsWith('.js')) files.push(path.join(ROOT, dir, n));
  }
  return files;
}

// Hash of the sources with the placeholder still in the page, so stamping the page does not change the id.
function computeId() {
  const h = crypto.createHash('sha256');
  for (const f of sourceFiles()) {
    h.update(path.relative(ROOT, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

let cache = null;
// The id of the running deployment: the stamp written at build time, else (local development) computed and cached per file change.
function currentBuild() {
  if (process.env.BUILD_ID) return String(process.env.BUILD_ID);
  try {
    const o = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    if (o && typeof o.build === 'string' && o.build) return o.build;
  } catch (e) { /* not stamped */ }
  try {
    const key = sourceFiles().map((f) => f + ':' + fs.statSync(f).mtimeMs).join('|');
    if (!cache || cache.key !== key) cache = { key, id: computeId() };
    return cache.id;
  } catch (e) { return null; } // unknown: callers must not treat this as a new version
}

module.exports = { PLACEHOLDER, INDEX, STAMP, computeId, currentBuild };
