import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim() !== '' && process.env.SESSION_SECRET.trim() !== 'change-me-to-a-long-random-string'
    ? process.env.SESSION_SECRET.trim()
    : crypto.randomBytes(48).toString('hex');

if (SECRET !== process.env.SESSION_SECRET) {
  console.warn('[BuildID] SESSION_SECRET not set — using ephemeral secret. Tokens will be invalidated on restart.');
}

const TTL = Number(process.env.LINK_CODE_TTL_SECONDS || 600);

export function issueHostToken(code) {
  return jwt.sign({ role: 'host', code }, SECRET, { expiresIn: TTL });
}

export function issueViewerToken(code, opts = {}) {
  const payload = { role: 'viewer', code };
  if (opts.trusted) payload.trusted = true;
  return jwt.sign(payload, SECRET, { expiresIn: TTL });
}

export function verifyHostToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    return payload.role === 'host' ? payload : null;
  } catch {
    return null;
  }
}

export function verifyViewerToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    return payload.role === 'viewer' ? payload : null;
  } catch {
    return null;
  }
}

export function generateLinkCode() {
  // Avoid look-alike chars (0/O, 1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
