module.exports = (req, res) => {
  const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
  const SIGNALING_URL = process.env.SIGNALING_URL || '';
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ iceServers: ICE_SERVERS, signalingUrl: SIGNALING_URL });
};
