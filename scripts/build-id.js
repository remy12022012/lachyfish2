'use strict';
// Vercel build step (see vercel.json). Stamps the build id into the page, public/version.json and lib/buildid.json.
// Safe to run twice: once the placeholder is gone the page is left alone.
const fs = require('fs');
const path = require('path');
const { PLACEHOLDER, INDEX, STAMP, computeId } = require('../lib/build');
const { SEASON } = require('../lib/util');

// Only on Vercel's build machine (or with --force): running it locally would overwrite the placeholder in the source page.
if (!process.env.VERCEL && !process.argv.includes('--force')) {
  console.log('build-id: not on Vercel, skipping (use --force to stamp locally)');
  process.exit(0);
}
const html = fs.readFileSync(INDEX, 'utf8');
if (!html.includes(PLACEHOLDER)) {
  console.log('build-id: public/index.html has no placeholder (already stamped), nothing to do');
  process.exit(0);
}
const id = computeId();
fs.writeFileSync(INDEX, html.split(PLACEHOLDER).join(id));
fs.writeFileSync(path.join(path.dirname(INDEX), 'version.json'), JSON.stringify({ build: id, season: SEASON, t: Date.now() }));
fs.writeFileSync(STAMP, JSON.stringify({ build: id }));
console.log('build-id: stamped ' + id);
