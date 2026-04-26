module.exports = (req, res) => {
  // Allow the downloaded standalone HTML file (opened from file://, Origin: null)
  // and any other origin to read public config.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let iceServers;
  try {
    const raw = (process.env.ICE_SERVERS || '').trim();
    iceServers = raw ? JSON.parse(raw) : [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch (e) {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  const SIGNALING_URL = (process.env.SIGNALING_URL || '').trim();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ iceServers, signalingUrl: SIGNALING_URL });
};
