// HMAC-SHA256 of a trust secret, using the same SESSION_SECRET as the server.
// The host computes this so it can push hashes (not raw secrets) to the server.

const crypto = require('node:crypto');

let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET === 'change-me-to-a-long-random-string') {
  // Fall back to a random per-process key — but warn loudly: trusts won't
  // verify across host restarts unless SESSION_SECRET matches the server's.
  SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[trust] SESSION_SECRET missing or default — trusts will not survive a host restart.');
}

function hashTrustSecret(secret) {
  return crypto.createHmac('sha256', SECRET).update(String(secret)).digest('hex');
}

module.exports = { hashTrustSecret };
