const { issueViewerToken } = require('./_lib/auth.cjs');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const body = await readJson(req);
  const code = String(body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'invalid_code_format' });
  const token = issueViewerToken(code);
  res.status(200).json({ token, code });
};

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(req.body);
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 32_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
