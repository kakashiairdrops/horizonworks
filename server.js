const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dataPath = path.join(root, 'data.json');
const port = Number(process.env.PORT || 3000);
const mimeTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function readData() {
  return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

async function persist(collection, entry) {
  if (supabaseUrl && supabaseKey) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${collection}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation' },
      body: JSON.stringify(entry)
    });
    if (!response.ok) throw new Error(`Supabase persistence failed: ${response.status}`);
    return (await response.json())[0];
  }
  const data = readData();
  data[collection].push(entry);
  writeData(data);
  return entry;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/api/health') return sendJson(response, 200, { ok: true });
  if (url.pathname === '/api/data' && request.method === 'GET') return sendJson(response, 200, readData());

  const collection = { '/api/applications': 'applications', '/api/briefs': 'briefs', '/api/payments': 'payments', '/api/projects': 'projects' }[url.pathname];
  if (collection && request.method === 'POST') {
    try {
      const body = await readBody(request);
      const entry = { id: `${collection.slice(0, 3)}_${Date.now()}`, created_at: new Date().toISOString(), source: body.source || 'workspace', values: body.values || body };
      if (collection === 'payments') Object.assign(entry, { status: body.status || 'pending_confirmation', amount: body.amount || null, asset: body.asset || null, network: body.network || null });
      if (collection === 'projects') Object.assign(entry, { name: body.name || 'Untitled project', status: body.status || 'active' });
      return sendJson(response, 201, await persist(collection, entry));
    } catch {
      return sendJson(response, 400, { error: 'Please send valid JSON.' });
    }
  }

  let requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(root, requestedPath));
  if (!filePath.startsWith(root)) return sendJson(response, 403, { error: 'Forbidden' });

  fs.readFile(filePath, (error, content) => {
    if (error) return sendJson(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found' });
    const extension = path.extname(filePath);
    const type = mimeTypes[extension] || 'application/octet-stream';
    if (extension === '.html') content = Buffer.from(content.toString().replace('</body>', '<script src="/app.js"></script></body>'));
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    response.end(content);
  });
});

server.listen(port, () => console.log(`Horizon is running at http://localhost:${port}`));
