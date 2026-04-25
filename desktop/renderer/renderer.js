// Renderer: builds the WebRTC peer, captures screen + audio, sends to viewer,
// receives input over a data channel and forwards to main for native injection.

const logEl = document.getElementById('log');
const sourceSelect = document.getElementById('source-select');
const fpsSelect = document.getElementById('fps-select');
const bitrateSelect = document.getElementById('bitrate-select');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const rotateBtn = document.getElementById('rotate-btn');
const copyBtn = document.getElementById('copy-btn');
const codeDisplay = document.getElementById('code-display');
const joinUrlEl = document.getElementById('join-url');
const sigStatus = document.getElementById('signaling-status');
const viewerStatus = document.getElementById('viewer-status');

let signalingUrl = 'http://localhost:8080';
let viewerUrl = signalingUrl;
let socket = null;
let pc = null;
let stream = null;
let inputChannel = null;
let hostToken = null;
let currentCode = null;
let currentViewerTrusted = false;

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[host]', line);
  const el = document.createElement('div');
  el.textContent = line;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function setSig(text, kind = '') { sigStatus.textContent = text; sigStatus.className = `status ${kind}`; }
function setViewer(text, kind = '') { viewerStatus.textContent = text; viewerStatus.className = `status ${kind}`; }

window.buildid.onConfig(({ signalingUrl: url, viewerUrl: vurl }) => {
  signalingUrl = url;
  viewerUrl = vurl || url;
  loadSocketIo(url).then(initSignaling).catch((e) => {
    setSig('script error', 'error');
    log('failed to load socket.io client:', e.message);
  });
  populateSources();
});

function loadSocketIo(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${url.replace(/\/$/, '')}/socket.io/socket.io.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error('socket.io script failed'));
    document.head.appendChild(s);
  });
}

async function populateSources() {
  const sources = await window.buildid.listSources();
  sourceSelect.innerHTML = '';
  sources.forEach((src) => {
    const opt = document.createElement('option');
    opt.value = src.id;
    opt.textContent = src.name + (src.display_id ? ` (display ${src.display_id})` : '');
    opt.dataset.displayId = src.display_id || '';
    sourceSelect.appendChild(opt);
  });
}

function initSignaling() {
  socket = io(signalingUrl, {
    // Polling first for reliability behind null-origin (Electron file://);
    // socket.io will upgrade to WebSocket transparently when available.
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    withCredentials: false,
  });
  socket.on('connect', () => {
    setSig('connected', 'connected');
    register();
  });
  socket.on('disconnect', () => setSig('disconnected', 'error'));
  socket.on('connect_error', (e) => { setSig('signaling error', 'error'); log('signaling error:', e.message); });

  socket.on('viewer:joined', (info) => {
    currentViewerTrusted = !!info?.trusted;
    setViewer(currentViewerTrusted ? 'trusted device' : 'viewer connected', 'viewer');
    log('viewer joined' + (currentViewerTrusted ? ' (trusted)' : '') + ' — sending offer');
    if (!stream) { log('no stream — start hosting first'); return; }
    startOffer();
  });
  socket.on('signal', handleSignal);
  socket.on('peer:closed', ({ reason }) => {
    log('peer closed:', reason);
    setViewer('no viewer');
    teardownPeer();
  });
}

function register() {
  socket.emit('host:register', {}, async (ack) => {
    if (ack?.error) { log('register failed:', ack.error); return; }
    currentCode = ack.code;
    hostToken = ack.hostToken;
    codeDisplay.textContent = ack.code;
    joinUrlEl.textContent = `${viewerUrl} — enter code on the website`;
    rotateBtn.disabled = false;
    copyBtn.disabled = false;
    log('registered, code:', ack.code);
    await pushTrustHashes();
    refreshTrustedList();
  });
}

async function pushTrustHashes() {
  try {
    const hashes = await window.buildid.trust.hashes();
    socket.emit('host:set-trusts', { hostToken, hashes }, (ack) => {
      if (ack?.error) log('trust sync error:', ack.error);
      else log(`trust sync: ${ack.count} device(s)`);
    });
  } catch (e) { log('trust hash error:', e.message); }
}

async function refreshTrustedList() {
  const list = await window.buildid.trust.list();
  const container = document.getElementById('trusted-list');
  const empty = document.getElementById('trusted-empty');
  container.innerHTML = '';
  if (!list.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'trust-row';
    const added = new Date(d.addedAt).toLocaleString();
    row.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="meta">added ${added}</div>
      </div>
      <button class="danger">Revoke</button>`;
    row.querySelector('.name').textContent = d.name;
    row.querySelector('button').addEventListener('click', async () => {
      await window.buildid.trust.revoke(d.id);
      await pushTrustHashes();
      refreshTrustedList();
    });
    container.appendChild(row);
  }
}

rotateBtn.addEventListener('click', () => {
  socket.emit('host:rotate', { hostToken }, (ack) => {
    if (ack?.error) { log('rotate failed:', ack.error); return; }
    currentCode = ack.code;
    hostToken = ack.hostToken;
    codeDisplay.textContent = ack.code;
    setViewer('no viewer');
    teardownPeer();
  });
});

copyBtn.addEventListener('click', async () => {
  if (!currentCode) return;
  try { await navigator.clipboard.writeText(currentCode); log('code copied'); } catch {}
});

// ── Capture ──────────────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  try {
    const sourceId = sourceSelect.value;
    const displayId = sourceSelect.selectedOptions[0]?.dataset.displayId;
    if (displayId) await window.buildid.setDisplay(displayId);

    const fps = Number(fpsSelect.value);

    // Electron-specific desktopCapturer constraints.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'desktop' },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: fps,
          maxWidth: 3840,
          maxHeight: 2160,
        },
      },
    });

    startBtn.disabled = true;
    stopBtn.disabled = false;
    log('capture started');
  } catch (e) {
    log('capture failed:', e.message);
  }
});

stopBtn.addEventListener('click', () => {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  teardownPeer();
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

// ── WebRTC ───────────────────────────────────────────────────────────────────
async function fetchIce() {
  try {
    const r = await fetch(`${signalingUrl}/api/config`);
    const j = await r.json();
    return j.iceServers || [];
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

async function startOffer() {
  teardownPeer();
  const iceServers = await fetchIce();
  pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

  pc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) socket.emit('signal', { kind: 'ice', data: ev.candidate });
  });
  pc.addEventListener('connectionstatechange', () => log('pc:', pc.connectionState));

  // Input channel — host listens; viewer also creates one as fallback.
  pc.addEventListener('datachannel', (ev) => {
    if (ev.channel.label === 'input') bindInput(ev.channel);
  });
  inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  bindInput(inputChannel);

  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  // Bias encoder for low latency.
  const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (videoSender) {
    const params = videoSender.getParameters();
    params.encodings = [{
      maxBitrate: Number(bitrateSelect.value),
      maxFramerate: Number(fpsSelect.value),
      networkPriority: 'high',
      priority: 'high',
    }];
    params.degradationPreference = 'maintain-framerate';
    try { await videoSender.setParameters(params); } catch (e) { log('setParameters failed:', e.message); }
  }

  const offer = await pc.createOffer();
  // Prefer H.264 if available for hardware decode on most clients.
  offer.sdp = preferCodec(offer.sdp, 'video', ['H264', 'VP9', 'VP8']);
  await pc.setLocalDescription(offer);
  socket.emit('signal', { kind: 'offer', data: offer });
}

async function handleSignal(msg) {
  if (!pc) return;
  try {
    if (msg.kind === 'answer') {
      await pc.setRemoteDescription(msg.data);
    } else if (msg.kind === 'ice') {
      try { await pc.addIceCandidate(msg.data); } catch (e) { console.warn('ICE add', e); }
    } else if (msg.kind === 'offer') {
      // Reverse offer (viewer-initiated, unusual)
      await pc.setRemoteDescription(msg.data);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit('signal', { kind: 'answer', data: ans });
    }
  } catch (e) {
    log('signal error:', e.message);
  }
}

function bindInput(ch) {
  inputChannel = ch;
  ch.addEventListener('open', () => log('input channel open'));
  ch.addEventListener('message', (ev) => {
    try {
      const event = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
      if (!event) return;
      if (event.t === 'trust:request') {
        handleTrustRequest(event, ch).catch((e) => log('trust req error:', e.message));
        return;
      }
      window.buildid.sendInput(event);
    } catch {}
  });
}

async function handleTrustRequest(req, ch) {
  if (currentViewerTrusted) {
    // Already trusted — silently ignore re-requests.
    return;
  }
  const id = String(req.id || '').slice(0, 128);
  const name = String(req.name || 'Unknown device').slice(0, 80);
  if (!id) return;
  log(`trust request from "${name}"`);
  const ok = await window.buildid.trust.confirm({ name });
  if (!ok) {
    safeSend(ch, { t: 'trust:result', ok: false });
    log('trust denied');
    return;
  }
  const entry = await window.buildid.trust.approve({ id, name });
  safeSend(ch, { t: 'trust:result', ok: true, secret: entry.secret });
  await pushTrustHashes();
  refreshTrustedList();
  log(`trust approved for "${name}"`);
}

function safeSend(ch, obj) {
  try { ch.send(JSON.stringify(obj)); } catch {}
}

function teardownPeer() {
  try { inputChannel?.close(); } catch {}
  try { pc?.close(); } catch {}
  inputChannel = null; pc = null;
}

// SDP munge: move preferred codec PTs to the front of the m=video line.
function preferCodec(sdp, kind, preferList) {
  const lines = sdp.split(/\r?\n/);
  const mIdx = lines.findIndex((l) => l.startsWith(`m=${kind} `));
  if (mIdx === -1) return sdp;

  const ptToCodec = new Map();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) ([^/]+)/);
    if (m) ptToCodec.set(m[1], m[2].toUpperCase());
  }

  const parts = lines[mIdx].split(' ');
  const header = parts.slice(0, 3);
  let pts = parts.slice(3);

  pts.sort((a, b) => {
    const ai = preferList.indexOf(ptToCodec.get(a));
    const bi = preferList.indexOf(ptToCodec.get(b));
    const av = ai === -1 ? 999 : ai;
    const bv = bi === -1 ? 999 : bi;
    return av - bv;
  });
  lines[mIdx] = [...header, ...pts].join(' ');
  return lines.join('\r\n');
}
