// BuildID web client (viewer).
// Connects to signaling, joins by code or trusted-device secret, receives
// WebRTC media + opens an input data channel.

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const joinPanel = $('#join');
const stage = $('#stage');
const video = $('#remote-video');
const overlay = $('#overlay');
const statsEl = $('#stats');
const stageInfo = $('#stage-info');
const audioToggle = $('#audio-toggle');
const controlToggle = $('#control-toggle');
const requestTrust = $('#request-trust');

const STORAGE_KEY = 'buildid:v1';

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
function saveStore(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

function getDeviceId() {
  const s = loadStore();
  if (s.deviceId) return s.deviceId;
  const id = (crypto.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)));
  s.deviceId = id;
  saveStore(s);
  return id;
}

function getDeviceName() {
  const s = loadStore();
  if (s.deviceName) return s.deviceName;
  const ua = navigator.userAgent || 'Unknown';
  let os = 'Device';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/CrOS/i.test(ua)) os = 'Chromebook';
  else if (/Mac OS X/i.test(ua)) os = 'Mac';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  s.deviceName = `${browser} on ${os}`;
  saveStore(s);
  return s.deviceName;
}

function getTrusts() {
  const s = loadStore();
  return Array.isArray(s.trusts) ? s.trusts : [];
}
function addTrust(entry) {
  const s = loadStore();
  s.trusts = (s.trusts || []).filter((t) => t.secret !== entry.secret);
  s.trusts.unshift(entry);
  saveStore(s);
}
function removeTrust(secret) {
  const s = loadStore();
  s.trusts = (s.trusts || []).filter((t) => t.secret !== secret);
  saveStore(s);
}

let pc = null;
let socket = null;
let inputChannel = null;
let statsTimer = null;
let connectedTrustSecret = null; // set when current connection used a trust secret
let signalingUrl = ''; // empty => same origin

function setStatus(text, kind = 'idle') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function loadConfig() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('config_failed');
  const cfg = await r.json();
  signalingUrl = cfg.signalingUrl || '';
  if (signalingUrl) await ensureSocketIoLoaded(signalingUrl);
  return cfg;
}

function ensureSocketIoLoaded(url) {
  // Same-origin loads come from /socket.io/socket.io.js (the server hosts it).
  // For a remote signaling server, we need to load the client from there.
  if (window.io) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${url.replace(/\/$/, '')}/socket.io/socket.io.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('signaling_unreachable'));
    document.head.appendChild(s);
  });
}

async function claimCode(code) {
  const r = await fetch('/api/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || 'claim_failed');
  }
  return r.json();
}

renderTrustedHosts();

$('#stealth-btn').addEventListener('click', () => {
  // Open about:blank then write an iframe pointing at the real viewer.
  // The address bar stays "about:blank".
  const w = window.open('about:blank', '_blank');
  if (!w) {
    const err = $('#join-error');
    err.textContent = 'Pop-up blocked. Allow pop-ups for this site and try again.';
    err.hidden = false;
    return;
  }
  const origin = location.origin;
  w.document.open();
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>about:blank</title>` +
    `<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style>` +
    `</head><body><iframe src="${origin}/" allow="autoplay; clipboard-read; clipboard-write; fullscreen; display-capture"></iframe></body></html>`
  );
  w.document.close();
});

function renderTrustedHosts() {
  const trusts = getTrusts();
  const block = $('#trusted-block');
  const list = $('#trusted-list');
  if (!block || !list) return;
  list.innerHTML = '';
  if (!trusts.length) { block.hidden = true; return; }
  block.hidden = false;
  for (const t of trusts) {
    const row = document.createElement('div');
    row.className = 'trusted-host';
    row.innerHTML = `
      <div style="flex:1">
        <div class="name"></div>
        <div style="color:#8b949e;font-size:11px">trusted ${new Date(t.addedAt).toLocaleDateString()}</div>
      </div>
      <button type="button" class="connect">Connect</button>
      <button type="button" class="ghost danger forget">Forget</button>`;
    row.querySelector('.name').textContent = t.label || 'Trusted host';
    row.querySelector('.connect').addEventListener('click', () => connectTrusted(t));
    row.querySelector('.forget').addEventListener('click', () => {
      removeTrust(t.secret);
      renderTrustedHosts();
    });
    list.appendChild(row);
  }
}

async function connectTrusted(trust) {
  const errEl = $('#join-error');
  errEl.hidden = true;
  try {
    setStatus('connecting', 'connecting');
    const { iceServers } = await loadConfig();
    connectedTrustSecret = trust.secret;
    await connect({ iceServers, trustSecret: trust.secret, trusted: true });
  } catch (e) {
    setStatus('error', 'error');
    errEl.textContent = friendlyError(e.message);
    errEl.hidden = false;
  }
}

$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const errEl = $('#join-error');
  errEl.hidden = true;
  const code = $('#code').value.trim().toUpperCase();
  try {
    setStatus('connecting', 'connecting');
    const { iceServers } = await loadConfig();
    const { token } = await claimCode(code);
    connectedTrustSecret = null;
    await connect({ iceServers, token, code, askToTrust: requestTrust.checked });
  } catch (e) {
    setStatus('error', 'error');
    errEl.textContent = friendlyError(e.message);
    errEl.hidden = false;
  }
});

function friendlyError(code) {
  switch (code) {
    case 'invalid_code_format': return 'Code must be 6 letters/numbers.';
    case 'no_such_code': return 'No host found for that code.';
    case 'already_connected': return 'Another viewer is already connected to that host.';
    case 'invalid_token': return 'Code expired. Try again.';
    case 'invalid_secret': return 'Stored trust is invalid. Forget and reconnect with a code.';
    case 'host_offline_or_revoked': return 'Host is offline or revoked this device. Use a code to connect.';
    default: return `Connection failed (${code}).`;
  }
}

async function connect({ iceServers, token, code, trustSecret, askToTrust = false, trusted = false }) {
  // signalingUrl was set by loadConfig(); empty => same origin.
  socket = signalingUrl ? io(signalingUrl, { transports: ['websocket'] }) : io({ transports: ['websocket'] });

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

  pc.addEventListener('track', (ev) => {
    if (video.srcObject !== ev.streams[0]) {
      video.srcObject = ev.streams[0];
    }
  });

  pc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) socket.emit('signal', { kind: 'ice', data: ev.candidate });
  });

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') {
      setStatus('connected', 'connected');
      stageInfo.textContent = trusted
        ? `Connected (trusted device)`
        : `Connected — code ${code}`;
      startStats();
    } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      setStatus(pc.connectionState, 'error');
    }
  });

  pc.addEventListener('datachannel', (ev) => {
    if (ev.channel.label === 'input') bindInputChannel(ev.channel, { askToTrust });
  });

  // Some hosts may create the channel from this side instead — fall back:
  inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  bindInputChannel(inputChannel, { askToTrust });

  socket.on('signal', async (msg) => {
    try {
      if (msg.kind === 'offer') {
        await pc.setRemoteDescription(msg.data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { kind: 'answer', data: answer });
      } else if (msg.kind === 'answer') {
        await pc.setRemoteDescription(msg.data);
      } else if (msg.kind === 'ice') {
        try { await pc.addIceCandidate(msg.data); } catch (e) { console.warn('ICE add failed', e); }
      }
    } catch (e) {
      console.error('signal handling failed', e);
    }
  });

  socket.on('peer:closed', ({ reason }) => {
    setStatus(`closed (${reason})`, 'error');
    teardown();
  });

  // Join the host's session.
  const ack = trustSecret
    ? await new Promise((res) => socket.emit('viewer:join-trusted', { secret: trustSecret }, res))
    : await new Promise((res) => socket.emit('viewer:join', { token }, res));
  if (ack?.error) throw new Error(ack.error);
  if (ack?.code && !code) code = ack.code;

  joinPanel.hidden = true;
  stage.hidden = false;
  overlay.focus();

  audioToggle.addEventListener('change', () => {
    video.muted = !audioToggle.checked;
  });
  video.muted = !audioToggle.checked;
}

function bindInputChannel(ch, opts = {}) {
  inputChannel = ch;
  ch.addEventListener('open', () => {
    console.log('[input] open');
    if (opts.askToTrust) {
      try {
        ch.send(JSON.stringify({
          t: 'trust:request',
          id: getDeviceId(),
          name: getDeviceName(),
        }));
      } catch {}
    }
  });
  ch.addEventListener('close', () => console.log('[input] closed'));
  ch.addEventListener('message', (ev) => {
    try {
      const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
      if (!msg) return;
      if (msg.t === 'trust:result') {
        if (msg.ok && msg.secret) {
          addTrust({
            secret: msg.secret,
            label: getDeviceName() + ' ↔ host',
            addedAt: Date.now(),
          });
          renderTrustedHosts();
          stageInfo.textContent = stageInfo.textContent + ' • trusted';
        }
      }
    } catch {}
  });
}

function send(msg) {
  if (!controlToggle.checked) return;
  if (!inputChannel || inputChannel.readyState !== 'open') return;
  try { inputChannel.send(JSON.stringify(msg)); } catch {}
}

// ── Input capture ────────────────────────────────────────────────────────────
// All coordinates are normalized 0..1 of the *video* surface so the host can
// map them to the captured screen regardless of browser size.
function videoCoords(ev) {
  const rect = video.getBoundingClientRect();
  // Find the actual rendered video area inside the element (object-fit: contain).
  const vw = video.videoWidth || rect.width;
  const vh = video.videoHeight || rect.height;
  const scale = Math.min(rect.width / vw, rect.height / vh) || 1;
  const renderW = vw * scale;
  const renderH = vh * scale;
  const offsetX = (rect.width - renderW) / 2;
  const offsetY = (rect.height - renderH) / 2;
  const x = (ev.clientX - rect.left - offsetX) / renderW;
  const y = (ev.clientY - rect.top - offsetY) / renderH;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

const buttonMap = { 0: 'left', 1: 'middle', 2: 'right' };

overlay.addEventListener('mousemove', (ev) => {
  const { x, y } = videoCoords(ev);
  send({ t: 'mm', x, y });
});
overlay.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  const { x, y } = videoCoords(ev);
  send({ t: 'md', x, y, b: buttonMap[ev.button] || 'left' });
});
overlay.addEventListener('mouseup', (ev) => {
  ev.preventDefault();
  const { x, y } = videoCoords(ev);
  send({ t: 'mu', x, y, b: buttonMap[ev.button] || 'left' });
});
overlay.addEventListener('contextmenu', (ev) => ev.preventDefault());
overlay.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  send({ t: 'wh', dx: ev.deltaX, dy: ev.deltaY });
}, { passive: false });

overlay.addEventListener('keydown', (ev) => {
  ev.preventDefault();
  send({ t: 'kd', code: ev.code, key: ev.key, mods: modBits(ev) });
});
overlay.addEventListener('keyup', (ev) => {
  ev.preventDefault();
  send({ t: 'ku', code: ev.code, key: ev.key, mods: modBits(ev) });
});

function modBits(ev) {
  return (
    (ev.shiftKey ? 1 : 0) |
    (ev.ctrlKey ? 2 : 0) |
    (ev.altKey ? 4 : 0) |
    (ev.metaKey ? 8 : 0)
  );
}

// ── UI controls ──────────────────────────────────────────────────────────────
$('#fullscreen-btn').addEventListener('click', () => {
  const wrap = $('#video-wrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen();
});

$('#disconnect-btn').addEventListener('click', () => {
  teardown();
  location.reload();
});

function startStats() {
  if (statsTimer) clearInterval(statsTimer);
  let lastBytes = 0, lastTs = 0;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let bitrate = 0, fps = 0, res = '', rtt = 0;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        if (lastTs) {
          const dt = (r.timestamp - lastTs) / 1000;
          bitrate = ((r.bytesReceived - lastBytes) * 8) / dt / 1000;
        }
        lastBytes = r.bytesReceived;
        lastTs = r.timestamp;
        fps = r.framesPerSecond || 0;
        res = `${r.frameWidth || '?'}x${r.frameHeight || '?'}`;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        rtt = r.currentRoundTripTime * 1000;
      }
    });
    statsEl.textContent =
      `video ${res}  ${fps.toFixed(0)} fps  ${bitrate.toFixed(0)} kbps  rtt ${rtt.toFixed(0)} ms`;
  }, 1000);
}

function teardown() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  try { inputChannel?.close(); } catch {}
  try { pc?.close(); } catch {}
  try { socket?.close(); } catch {}
  pc = null; inputChannel = null; socket = null;
}
