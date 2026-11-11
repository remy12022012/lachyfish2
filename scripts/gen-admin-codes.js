'use strict';
// Makes admin codes. Usage: node scripts/gen-admin-codes.js [staffCount=3] [ownerCount=0]
// Hand each code to one person (they paste it into the game's dev panel while signed in). Put the printed ADMIN_CODES line into Vercel
// (Settings, Environment Variables) and redeploy. Only the hashes go to the server; the codes themselves are never stored anywhere.
const crypto = require('crypto');
const { hashCode } = require('../lib/adminCodes');

const staff = Math.max(0, parseInt(process.argv[2], 10) || 3);
const owner = Math.max(0, parseInt(process.argv[3], 10) || 0);
const mkCode = () => crypto.randomBytes(20).toString('hex').match(/.{4}/g).join('-'); // 160 bits, easy to paste

const entries = [];
console.log('Codes (give each to one person; each works once, for the first account that redeems it):\n');
for (let i = 0; i < staff + owner; i++) {
  const isOwner = i >= staff, c = mkCode();
  console.log((isOwner ? 'OWNER ' : 'staff ') + c);
  entries.push((isOwner ? 'owner:' : '') + hashCode(c));
}
console.log('\nADMIN_CODES (set this in Vercel; keep only the hashes of codes you still want valid):\n');
console.log(entries.join(','));
