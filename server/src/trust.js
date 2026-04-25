import crypto from 'node:crypto';

const SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET !== 'change-me-to-a-long-random-string'
    ? process.env.SESSION_SECRET
    : crypto.randomBytes(48).toString('hex');

// HMAC-SHA256 of a viewer-supplied trust secret. Host registers the same
// HMAC with the server, so the raw secret never has to be stored server-side.
export function hashTrustSecret(secret) {
  return crypto.createHmac('sha256', SECRET).update(String(secret)).digest('hex');
}
