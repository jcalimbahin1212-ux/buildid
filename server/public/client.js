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

// ── Download viewer as a single self-contained HTML file ─────────────────────
// Inlines style.css and client.js, and adds <base href> so root-relative
// fetches (/api/config, /api/claim) still hit the production origin when the
// file is opened from disk (file://).
const downloadBtn = $('#download-btn');
if (downloadBtn) {
  downloadBtn.addEventListener('click', async () => {
    const errEl = $('#join-error');
    errEl.hidden = true;
    const orig = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Building…';
    try {
      const origin = location.origin;
      const [css, js] = await Promise.all([
        fetch('/style.css').then((r) => r.ok ? r.text() : Promise.reject(new Error('style_failed'))),
        fetch('/client.js').then((r) => r.ok ? r.text() : Promise.reject(new Error('client_failed'))),
      ]);

      // Build the HTML by cloning the live document, then swapping linked
      // resources for inline ones. This keeps the markup in sync with whatever
      // the page is right now.
      const doc = document.implementation.createHTMLDocument('BuildID');
      doc.documentElement.lang = 'en';

      // Head: base href + meta + title + inline style
      const head = doc.head;
      const base = doc.createElement('base');
      base.href = origin + '/';
      head.appendChild(base);

      const meta1 = doc.createElement('meta'); meta1.setAttribute('charset', 'utf-8'); head.appendChild(meta1);
      const meta2 = doc.createElement('meta');
      meta2.setAttribute('name', 'viewport');
      meta2.setAttribute('content', 'width=device-width,initial-scale=1');
      head.appendChild(meta2);

      const title = doc.createElement('title');
      title.textContent = 'BuildID — Remote Viewer';
      head.appendChild(title);

      const style = doc.createElement('style');
      style.textContent = css;
      head.appendChild(style);

      // Body: copy live <body> innerHTML minus the existing <script> tags.
      const liveBody = document.body.cloneNode(true);
      liveBody.querySelectorAll('script').forEach((s) => s.remove());
      // Strip any join-error state.
      const je = liveBody.querySelector('#join-error');
      if (je) { je.hidden = true; je.textContent = ''; }
      // Hide the stage panel by default in the saved file (always start at join).
      const stageEl = liveBody.querySelector('#stage');
      if (stageEl) stageEl.hidden = true;
      const joinEl = liveBody.querySelector('#join');
      if (joinEl) joinEl.hidden = false;
      // Reset status.
      const statusBadge = liveBody.querySelector('#status');
      if (statusBadge) {
        statusBadge.className = 'status idle';
        statusBadge.textContent = 'disconnected';
      }
      doc.body.innerHTML = liveBody.innerHTML;

      // Scripts: socket.io is fetched from the signaling server lazily by
      // ensureSocketIoLoaded() in the bundled client, so we only need the
      // inlined client.js. That code uses /api/config which resolves against
      // <base href>, so it still hits Vercel.
      const script = doc.createElement('script');
      script.type = 'module';
      script.textContent = js;
      doc.body.appendChild(script);

      const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'BuildID.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloadBtn.textContent = 'Downloaded ✓';
      setTimeout(() => { downloadBtn.textContent = orig; downloadBtn.disabled = false; }, 1500);
    } catch (e) {
      errEl.textContent = 'Could not build offline file: ' + (e.message || 'unknown');
      errEl.hidden = false;
      downloadBtn.textContent = orig;
      downloadBtn.disabled = false;
    }
  });
}

function renderTrustedHosts() {
  const trusts = getTrusts();
  const block = $('#trusted-block');
  const list = $('#trusted-list');
  const qc = $('#quick-connect');
  const qcName = $('#qc-name');
  const qcButton = $('#qc-button');

  // Quick-connect card: bind to most recent trusted host (first item).
  if (qc && qcName && qcButton) {
    if (trusts.length) {
      qc.hidden = false;
      qcName.textContent = trusts[0].label || 'Trusted host';
      qcButton.onclick = () => connectTrusted(trusts[0]);
    } else {
      qc.hidden = true;
      qcButton.onclick = null;
    }
  }

  if (!block || !list) return;
  list.innerHTML = '';
  if (!trusts.length) { block.hidden = true; return; }
  block.hidden = false;
  for (const t of trusts) {
    const row = document.createElement('div');
    row.className = 'trusted-host';
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="name"></div>
        <div style="color:var(--muted);font-size:11px">trusted ${new Date(t.addedAt).toLocaleDateString()}</div>
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

// ── Touch / mobile controls ──────────────────────────────────────────────────
// A virtual on-screen joystick drives a virtual cursor (normalized 0..1 of the
// video surface). Action buttons send clicks / scroll. A hidden text input
// summons the device's soft keyboard and forwards keystrokes.
(function setupTouchControls() {
  const isTouch =
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    matchMedia('(pointer: coarse)').matches;

  const touchToggle = $('#touch-toggle');
  const controls = $('#touch-controls');
  const cursorEl = $('#virtual-cursor');
  const stick = $('#joystick');
  const knob = $('#joystick-knob');
  const kbdInput = $('#touch-keyboard');
  if (!touchToggle || !controls || !stick) return;

  // Default ON for touch devices.
  if (isTouch) touchToggle.checked = true;

  let active = false;
  // Virtual cursor in normalized 0..1 video coords.
  let cur = { x: 0.5, y: 0.5 };
  // Joystick vector in -1..1 range.
  let vec = { x: 0, y: 0 };
  let dragId = null;
  let rafId = null;
  let lastTs = 0;

  function show(on) {
    active = !!on;
    controls.hidden = !on;
    cursorEl.hidden = !on;
    if (on) {
      placeCursor();
      startLoop();
    } else {
      stopLoop();
      vec.x = 0; vec.y = 0;
      resetKnob();
    }
  }

  function placeCursor() {
    // Position virtualCursor inside the video-wrap based on cur (normalized).
    const rect = video.getBoundingClientRect();
    const wrapRect = $('#video-wrap').getBoundingClientRect();
    const vw = video.videoWidth || rect.width;
    const vh = video.videoHeight || rect.height;
    const scale = Math.min(rect.width / vw, rect.height / vh) || 1;
    const renderW = vw * scale;
    const renderH = vh * scale;
    const offsetX = (rect.width - renderW) / 2 + (rect.left - wrapRect.left);
    const offsetY = (rect.height - renderH) / 2 + (rect.top - wrapRect.top);
    cursorEl.style.left = (offsetX + cur.x * renderW) + 'px';
    cursorEl.style.top = (offsetY + cur.y * renderH) + 'px';
  }

  function resetKnob() {
    knob.style.transform = 'translate(0px, 0px)';
  }

  // Joystick drag handling via Pointer Events (works for touch, mouse, pen).
  stick.addEventListener('pointerdown', (ev) => {
    if (!active) return;
    dragId = ev.pointerId;
    stick.setPointerCapture(dragId);
    updateJoystick(ev);
  });
  stick.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== dragId) return;
    updateJoystick(ev);
  });
  function endDrag(ev) {
    if (ev.pointerId !== dragId) return;
    try { stick.releasePointerCapture(dragId); } catch {}
    dragId = null;
    vec.x = 0; vec.y = 0;
    resetKnob();
  }
  stick.addEventListener('pointerup', endDrag);
  stick.addEventListener('pointercancel', endDrag);
  stick.addEventListener('pointerleave', (ev) => { if (ev.pointerId === dragId) endDrag(ev); });

  function updateJoystick(ev) {
    const rect = stick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = ev.clientX - cx;
    let dy = ev.clientY - cy;
    const max = rect.width / 2 - 20;
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Apply small dead-zone so resting finger doesn't drift.
    const dead = 8;
    const ndx = Math.abs(dx) < dead ? 0 : dx / max;
    const ndy = Math.abs(dy) < dead ? 0 : dy / max;
    vec.x = Math.max(-1, Math.min(1, ndx));
    vec.y = Math.max(-1, Math.min(1, ndy));
  }

  function startLoop() {
    if (rafId) return;
    lastTs = performance.now();
    const step = (ts) => {
      const dt = Math.min(50, ts - lastTs); // ms
      lastTs = ts;
      // Speed scales with joystick magnitude squared for finer control near center.
      const mag = Math.hypot(vec.x, vec.y);
      if (mag > 0) {
        // Cursor speed in normalized units per ms. 0.0008 ≈ full-screen in ~1.25s at full tilt.
        const speed = 0.0008 * (0.3 + mag) * mag; // gentle curve
        cur.x = Math.max(0, Math.min(1, cur.x + vec.x * speed * dt));
        cur.y = Math.max(0, Math.min(1, cur.y + vec.y * speed * dt));
        placeCursor();
        send({ t: 'mm', x: cur.x, y: cur.y });
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }
  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // Reposition cursor on resize / fullscreen / video metadata.
  window.addEventListener('resize', () => active && placeCursor());
  document.addEventListener('fullscreenchange', () => active && placeCursor());
  video.addEventListener('loadedmetadata', () => active && placeCursor());

  // Action buttons: left/right click, scroll, keyboard.
  controls.querySelectorAll('.tbtn').forEach((btn) => {
    const act = btn.dataset.act;
    if (act === 'left' || act === 'right') {
      const button = act;
      const press = (ev) => {
        ev.preventDefault();
        send({ t: 'md', x: cur.x, y: cur.y, b: button });
      };
      const release = (ev) => {
        ev.preventDefault();
        send({ t: 'mu', x: cur.x, y: cur.y, b: button });
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', (ev) => {
        // Only release if a press is in progress (button has :active style); harmless otherwise.
        if (ev.buttons === 0) return;
        release(ev);
      });
    } else if (act === 'scroll-up' || act === 'scroll-down') {
      const dir = act === 'scroll-up' ? -1 : 1;
      // Repeat while held.
      let timer = null;
      const fire = () => send({ t: 'wh', dx: 0, dy: dir * 80 });
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        fire();
        timer = setInterval(fire, 80);
      });
      const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      btn.addEventListener('pointerleave', stop);
    } else if (act === 'keyboard') {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (kbdInput.classList.contains('active')) {
          kbdInput.classList.remove('active');
          kbdInput.blur();
        } else {
          kbdInput.classList.add('active');
          kbdInput.value = '';
          kbdInput.focus();
        }
      });
    }
  });

  // Soft-keyboard input: forward each character as kd+ku, plus support Backspace/Enter.
  kbdInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Backspace' || ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      send({ t: 'kd', code: keyToCode(ev.key), key: ev.key, mods: modBits(ev) });
      send({ t: 'ku', code: keyToCode(ev.key), key: ev.key, mods: modBits(ev) });
    }
  });
  kbdInput.addEventListener('input', (ev) => {
    const data = ev.data;
    if (typeof data !== 'string' || !data) return;
    for (const ch of data) {
      const code = charToCode(ch);
      const mods = /[A-Z]/.test(ch) ? 1 : 0;
      send({ t: 'kd', code, key: ch, mods });
      send({ t: 'ku', code, key: ch, mods });
    }
    // Keep field empty so iOS keyboard always sends "input" events for new chars.
    kbdInput.value = '';
  });

  function keyToCode(k) {
    if (k === 'Backspace') return 'Backspace';
    if (k === 'Enter') return 'Enter';
    if (k === 'Tab') return 'Tab';
    return '';
  }
  function charToCode(ch) {
    if (ch === ' ') return 'Space';
    if (/[a-z]/i.test(ch)) return 'Key' + ch.toUpperCase();
    if (/[0-9]/.test(ch)) return 'Digit' + ch;
    return '';
  }

  touchToggle.addEventListener('change', () => show(touchToggle.checked));
  // Apply default state when stage becomes visible.
  const obs = new MutationObserver(() => {
    if (!stage.hidden && touchToggle.checked) show(true);
    if (stage.hidden) show(false);
  });
  obs.observe(stage, { attributes: true, attributeFilter: ['hidden'] });
})();

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
