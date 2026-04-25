// Serverless equivalent of the Express /cloak.html route.
module.exports = (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).send(
    `<!doctype html>
<meta charset="utf-8">
<title>about:blank</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe src="/" allow="autoplay; clipboard-read; clipboard-write; fullscreen; display-capture"></iframe>`
  );
};
