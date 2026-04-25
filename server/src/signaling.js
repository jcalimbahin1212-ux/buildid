// Signaling: the server only relays SDP/ICE between a host and a viewer that
// share a link code (or a trusted-device secret). It never sees media or input.

import { generateLinkCode, verifyHostToken, issueHostToken } from './auth.js';
import { hashTrustSecret } from './trust.js';

/**
 * Sessions keyed by 6-char link code.
 *  { code, hostSocketId, viewerSocketId|null, createdAt, expiresAt, trustedHashes:Set }
 */
const sessions = new Map();

/** trustHashIndex: hashed trust secret → code (so a viewer with a trust
 *  secret can find the host's current session in O(1)). */
const trustHashIndex = new Map();

const TTL_MS = Number(process.env.LINK_CODE_TTL_SECONDS || 600) * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (s.expiresAt < now && !s.viewerSocketId) deleteSession(code);
  }
}, 30_000).unref();

function deleteSession(code) {
  const s = sessions.get(code);
  if (!s) return;
  for (const h of s.trustedHashes) trustHashIndex.delete(h);
  sessions.delete(code);
}

export function findCodeByTrustHash(hash) {
  return trustHashIndex.get(hash) || null;
}

export { hashTrustSecret };

export function attachSignaling(io, { verifyViewerToken }) {
  io.on('connection', (socket) => {
    let role = null; // 'host' | 'viewer'
    let code = null;

    // ── HOST: desktop app registers and gets a fresh link code ─────────────
    socket.on('host:register', (_payload, ack) => {
      let newCode;
      for (let i = 0; i < 5; i++) {
        newCode = generateLinkCode();
        if (!sessions.has(newCode)) break;
      }
      if (sessions.has(newCode)) return ack?.({ error: 'code_collision' });

      sessions.set(newCode, {
        code: newCode,
        hostSocketId: socket.id,
        viewerSocketId: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + TTL_MS,
        trustedHashes: new Set(),
      });
      role = 'host';
      code = newCode;
      socket.join(`code:${newCode}`);
      ack?.({ code: newCode, hostToken: issueHostToken(newCode), ttlSeconds: TTL_MS / 1000 });
    });

    // Host can rotate the code at any time. Trust list carries over.
    socket.on('host:rotate', (payload, ack) => {
      const tok = verifyHostToken(payload?.hostToken);
      if (!tok || tok.code !== code) return ack?.({ error: 'unauthorized' });
      const session = sessions.get(code);
      if (!session) return ack?.({ error: 'no_session' });
      if (session.viewerSocketId) {
        io.to(session.viewerSocketId).emit('peer:closed', { reason: 'host_rotated' });
        session.viewerSocketId = null;
      }

      let newCode;
      for (let i = 0; i < 5; i++) {
        newCode = generateLinkCode();
        if (!sessions.has(newCode)) break;
      }
      const carriedTrust = session.trustedHashes;
      sessions.delete(code);
      sessions.set(newCode, {
        code: newCode,
        hostSocketId: socket.id,
        viewerSocketId: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + TTL_MS,
        trustedHashes: carriedTrust,
      });
      for (const h of carriedTrust) trustHashIndex.set(h, newCode);

      socket.leave(`code:${code}`);
      socket.join(`code:${newCode}`);
      code = newCode;
      ack?.({ code: newCode, hostToken: issueHostToken(newCode), ttlSeconds: TTL_MS / 1000 });
    });

    // Host pushes its full set of trusted device hashes. Hashes only — never
    // the raw secrets, so an attacker who breaches the server can't replay them.
    socket.on('host:set-trusts', (payload, ack) => {
      const tok = verifyHostToken(payload?.hostToken);
      if (!tok || tok.code !== code) return ack?.({ error: 'unauthorized' });
      const session = sessions.get(code);
      if (!session) return ack?.({ error: 'no_session' });
      const incoming = new Set(Array.isArray(payload?.hashes) ? payload.hashes : []);
      for (const h of session.trustedHashes) {
        if (!incoming.has(h)) trustHashIndex.delete(h);
      }
      for (const h of incoming) trustHashIndex.set(h, code);
      session.trustedHashes = incoming;
      ack?.({ ok: true, count: incoming.size });
    });

    // ── VIEWER: web client joins using a claimed token ─────────────────────
    socket.on('viewer:join', (payload, ack) => {
      const tok = verifyViewerToken(payload?.token);
      if (!tok) return ack?.({ error: 'invalid_token' });
      const session = sessions.get(tok.code);
      if (!session) return ack?.({ error: 'no_such_code' });
      if (session.viewerSocketId) return ack?.({ error: 'already_connected' });

      session.viewerSocketId = socket.id;
      role = 'viewer';
      code = tok.code;
      socket.join(`code:${code}`);

      io.to(session.hostSocketId).emit('viewer:joined', {
        viewerSocketId: socket.id,
        trusted: tok.trusted === true,
      });
      ack?.({ ok: true });
    });

    // Trusted-device join: the viewer presents the raw trust secret and we
    // look up the host's session by HMAC. Avoids needing shared state with a
    // separate REST endpoint (works when REST is on Vercel and signaling is
    // on a different host).
    socket.on('viewer:join-trusted', (payload, ack) => {
      const secret = String(payload?.secret || '');
      if (!secret || secret.length < 16) return ack?.({ error: 'invalid_secret' });
      const targetCode = trustHashIndex.get(hashTrustSecret(secret));
      if (!targetCode) return ack?.({ error: 'host_offline_or_revoked' });
      const session = sessions.get(targetCode);
      if (!session) return ack?.({ error: 'host_offline_or_revoked' });
      if (session.viewerSocketId) return ack?.({ error: 'already_connected' });

      session.viewerSocketId = socket.id;
      role = 'viewer';
      code = targetCode;
      socket.join(`code:${code}`);

      io.to(session.hostSocketId).emit('viewer:joined', {
        viewerSocketId: socket.id,
        trusted: true,
      });
      ack?.({ ok: true, code: targetCode });
    });

    // ── Generic relay: SDP + ICE ───────────────────────────────────────────
    socket.on('signal', (payload) => {
      if (!code) return;
      const session = sessions.get(code);
      if (!session) return;
      const target =
        socket.id === session.hostSocketId ? session.viewerSocketId : session.hostSocketId;
      if (!target) return;
      io.to(target).emit('signal', payload);
    });

    socket.on('disconnect', () => {
      if (!code) return;
      const session = sessions.get(code);
      if (!session) return;
      if (role === 'host') {
        if (session.viewerSocketId) {
          io.to(session.viewerSocketId).emit('peer:closed', { reason: 'host_disconnected' });
        }
        deleteSession(code);
      } else if (role === 'viewer') {
        session.viewerSocketId = null;
        io.to(session.hostSocketId).emit('peer:closed', { reason: 'viewer_disconnected' });
      }
    });
  });
}
