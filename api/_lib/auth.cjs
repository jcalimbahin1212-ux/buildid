// Shared auth helpers usable from both the long-running signaling server and
// from Vercel serverless functions. CommonJS so /api/*.js can require it.

const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim() !== '' && process.env.SESSION_SECRET.trim() !== 'change-me-to-a-long-random-string'
    ? process.env.SESSION_SECRET.trim()
    : crypto.randomBytes(48).toString('hex');

const TTL = Number(process.env.LINK_CODE_TTL_SECONDS || 600);

function issueViewerToken(code, opts = {}) {
  const payload = { role: 'viewer', code };
  if (opts.trusted) payload.trusted = true;
  return jwt.sign(payload, SECRET, { expiresIn: TTL });
}

function verifyViewerToken(token) {
  try {
    const p = jwt.verify(token, SECRET);
    return p.role === 'viewer' ? p : null;
  } catch { return null; }
}

function hashTrustSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

module.exports = { issueViewerToken, verifyViewerToken, hashTrustSecret };
