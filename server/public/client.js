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

// ── Download viewer as a "math worksheet" decoy ──────────────────────────────
// The generated HTML looks like an innocuous algebra worksheet. Typing the
// passphrase "james" into any answer field opens the real viewer in an
// about:blank window (same trick as the stealth button).
const downloadBtn = $('#download-btn');
if (downloadBtn) {
  downloadBtn.addEventListener('click', () => {
    const orig = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Building…';
    try {
      const viewerUrl = location.origin + '/';
      const html = buildWorksheetHtml(viewerUrl);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Algebra_Practice_Worksheet.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloadBtn.textContent = 'Downloaded ✓';
      setTimeout(() => { downloadBtn.textContent = orig; downloadBtn.disabled = false; }, 1500);
    } catch (e) {
      const errEl = $('#join-error');
      errEl.textContent = 'Could not build file: ' + (e.message || 'unknown');
      errEl.hidden = false;
      downloadBtn.textContent = orig;
      downloadBtn.disabled = false;
    }
  });
}

function buildWorksheetHtml(viewerUrl) {
  const problems = [
    { q: 'Solve for x:  3x + 7 = 22', a: '5' },
    { q: 'Simplify:  4(2x − 3) − 5x', a: '3x − 12' },
    { q: 'Factor:  x² − 9', a: '(x−3)(x+3)' },
    { q: 'Solve:  2x − 5 = x + 4', a: '9' },
    { q: 'Evaluate:  (−3)² + 4·5', a: '29' },
    { q: 'Solve for y:  y/4 = 7', a: '28' },
    { q: 'Simplify:  (2x³)(3x²)', a: '6x⁵' },
    { q: 'Solve:  x² = 49', a: '±7' },
    { q: 'Distribute:  −2(3x − 4)', a: '−6x + 8' },
    { q: 'Solve:  5(x − 1) = 2x + 7', a: '4' },
    { q: 'Slope between (2, 3) and (6, 11)', a: '2' },
    { q: 'Simplify:  √(50)', a: '5√2' },
  ];

  const rows = problems.map((p, i) => `
        <li>
          <span class="q">${p.q}</span>
          <span class="ans">x = <input type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-i="${i}"></span>
        </li>`).join('');

  // Note: the trigger listener and viewer-open logic are kept short and
  // unobtrusive so the page reads as a normal worksheet.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Algebra I — Practice Worksheet</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #f7f6f1; color: #222; font: 15px/1.55 Georgia, "Times New Roman", serif; }
  .sheet { max-width: 760px; margin: 28px auto; background: #fff; padding: 36px 44px; border: 1px solid #d8d4c7; box-shadow: 0 1px 0 #ece7d7, 0 8px 24px rgba(0,0,0,0.06); }
  header.sheet-h { border-bottom: 2px solid #222; padding-bottom: 10px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: end; }
  header.sheet-h h1 { margin: 0; font-size: 22px; letter-spacing: 0.3px; }
  header.sheet-h .meta { font-size: 12px; color: #555; }
  .name-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 22px; font-size: 13px; }
  .name-row label { display: block; color: #555; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 2px; }
  .name-row input { width: 100%; padding: 4px 0; border: none; border-bottom: 1px solid #888; font: inherit; background: transparent; outline: none; }
  .instructions { background: #fffdf3; border-left: 3px solid #c9a227; padding: 10px 14px; font-size: 13px; color: #4b3d10; margin-bottom: 20px; }
  ol.problems { padding-left: 22px; margin: 0; }
  ol.problems li { margin: 0 0 14px; padding: 6px 0; display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 1px dotted #cfc9b6; }
  ol.problems li:last-child { border-bottom: none; }
  .q { flex: 1; font-size: 15px; }
  .ans { font-family: "Cambria Math", "Times New Roman", serif; color: #333; }
  .ans input { width: 110px; padding: 3px 6px; font: inherit; border: 1px solid #b9b3a0; background: #fcfbf5; border-radius: 2px; outline: none; }
  .ans input:focus { border-color: #6b5b1f; background: #fff; }
  footer.sheet-f { margin-top: 24px; font-size: 11px; color: #777; text-align: center; border-top: 1px solid #ece7d7; padding-top: 10px; }
  @media print { body { background: #fff; } .sheet { box-shadow: none; border: none; margin: 0; padding: 24px; } }
</style>
</head>
<body>
  <main class="sheet">
    <header class="sheet-h">
      <h1>Algebra I — Practice Worksheet</h1>
      <div class="meta">Unit 4 · Equations &amp; Expressions</div>
    </header>

    <div class="name-row">
      <div><label>Name</label><input type="text" autocomplete="off"></div>
      <div><label>Class</label><input type="text" autocomplete="off"></div>
      <div><label>Date</label><input type="text" autocomplete="off"></div>
    </div>

    <div class="instructions">
      <strong>Instructions:</strong> Solve each problem and write your answer in the box.
      Show your work on a separate sheet of paper. Reduce all fractions to lowest terms.
    </div>

    <ol class="problems">${rows}
    </ol>

    <footer class="sheet-f">Page 1 of 1 · Algebra I · Practice Set 4B</footer>
  </main>

<script>
(function(){
  var TARGET = ${JSON.stringify(viewerUrl)};
  var PASS = 'james';
  function trigger(input){
    try { input.value = ''; } catch(e){}
    try { input.blur(); } catch(e){}
    var w = window.open('about:blank', '_blank');
    if (!w) {
      // Pop-up blocked — fall back to same-tab navigation.
      try { location.href = TARGET; } catch(e){}
      return;
    }
    // Cache-buster to avoid the browser reusing a previously-cached
    // response that may have had blocking headers.
    var src = TARGET + (TARGET.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    var html =
      '<!doctype html><html><head><meta charset="utf-8"><title>about:blank</title>' +
      '<style>html,body{margin:0;height:100%;background:#000;color:#bbb;font:13px sans-serif}' +
      '#f{border:0;width:100%;height:100%;display:block}' +
      '#fb{position:fixed;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px}' +
      '#fb a{color:#4f8cff;text-decoration:underline;cursor:pointer}' +
      '</style></head><body>' +
      '<iframe id="f" src="' + src + '" allow="autoplay; clipboard-read; clipboard-write; fullscreen; display-capture"></iframe>' +
      '<div id="fb">Could not embed page. <a id="go">Open directly →</a></div>' +
      '<script>(function(){' +
        'var f=document.getElementById("f"),fb=document.getElementById("fb"),go=document.getElementById("go");' +
        'go.onclick=function(){location.href=' + JSON.stringify(src) + '};' +
        'var loaded=false;' +
        'f.addEventListener("load",function(){loaded=true});' +
        'setTimeout(function(){if(!loaded){f.style.display="none";fb.style.display="flex";}},2500);' +
      '})();<\\/script>' +
      '</body></html>';
    w.document.open();
    w.document.write(html);
    w.document.close();
  }
  document.addEventListener('input', function(ev){
    var t = ev.target;
    if (!t || t.tagName !== 'INPUT') return;
    var v = String(t.value || '').toLowerCase().replace(/\\s+/g,'');
    if (v.indexOf(PASS) !== -1) trigger(t);
  });
})();
</script>
</body>
</html>`;
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
