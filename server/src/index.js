import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { Server as IOServer } from 'socket.io';
import { attachSignaling, findCodeByTrustHash, hashTrustSecret } from './signaling.js';
import { issueViewerToken, verifyViewerToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || '[]');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Allow inline scripts only for our small bootstrap; tighten in prod with a nonce.
        'script-src': ["'self'"],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'media-src': ["'self'", 'blob:', 'mediastream:'],
        'img-src': ["'self'", 'data:', 'blob:'],
        // Allow the page to be framed by about:blank (stealth cloak).
        'frame-ancestors': ["'self'", 'about:'],
      },
    },
    // Same reason — let about:blank embed us.
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    xFrameOptions: false,
  }),
);

// Static web client
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// Public runtime config the client needs.
app.get('/api/config', (_req, res) => {
  res.json({ iceServers: ICE_SERVERS });
});

// Viewer claims a link code shown by the desktop host.
// Returns a short-lived JWT bound to that code so signaling can authorize them.
app.post('/api/claim', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: 'invalid_code_format' });
  }
  const token = issueViewerToken(code);
  res.json({ token, code });
});

// Trusted-device claim. Viewer presents the secret it was given when the host
// previously approved trust. We hash it (HMAC) and look up the host's session.
app.post('/api/claim-trusted', (req, res) => {
  const secret = String(req.body?.secret || '');
  if (!secret || secret.length < 16) {
    return res.status(400).json({ error: 'invalid_secret' });
  }
  const code = findCodeByTrustHash(hashTrustSecret(secret));
  if (!code) return res.status(404).json({ error: 'host_offline_or_revoked' });
  const token = issueViewerToken(code, { trusted: true });
  res.json({ token, code });
});

// Stealth ("about:blank") cloak page. The viewer page provides a button that
// opens this in a new tab via about:blank + document.write so the address
// bar shows about:blank with the real app inside an iframe.
app.get('/cloak.html', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>about:blank</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe src="/" allow="autoplay; clipboard-read; clipboard-write; fullscreen; display-capture"></iframe>`);
});

// Health
app.get('/healthz', (_req, res) => res.send('ok'));

const useTls = process.env.TLS_CERT && process.env.TLS_KEY;
const server = useTls
  ? https.createServer(
      {
        cert: fs.readFileSync(process.env.TLS_CERT),
        key: fs.readFileSync(process.env.TLS_KEY),
      },
      app,
    )
  : http.createServer(app);

const io = new IOServer(server, {
  cors: {
    // ALLOWED_ORIGINS is a comma-separated list. Use "*" in dev only.
    // Electron host renderers have no Origin header (file://) — allow those too.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allow = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      if (!allow || allow.includes('*') || allow.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'), false);
    },
    credentials: false,
  },
  maxHttpBufferSize: 1e6,
  pingInterval: 10_000,
  pingTimeout: 20_000,
});

attachSignaling(io, { verifyViewerToken });

server.listen(PORT, () => {
  const proto = useTls ? 'https' : 'http';
  console.log(`[BuildID] signaling+web on ${proto}://localhost:${PORT}`);
  if (!ICE_SERVERS.length) {
    console.warn('[BuildID] WARNING: no ICE servers configured. Set ICE_SERVERS in .env');
  }
});
