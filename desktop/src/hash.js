// SHA-256 of a trust secret. The secret itself is 32+ random bytes, so a
// plain hash is unforgeable without it. Using a plain hash (no HMAC key)
// means host, server, and viewer all derive identical hashes regardless of
// whether SESSION_SECRET is configured locally.

const crypto = require('node:crypto');

function hashTrustSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

module.exports = { hashTrustSecret };
