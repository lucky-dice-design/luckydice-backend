import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const root = process.env.SITE_ROOT || '/app/site';
const tokenPath = process.env.TOKEN_PATH || '/app/contact_token';
const cms = process.env.DIRECTUS_URL;
const origins = new Set(['https://luckydicedesign.de', 'https://www.luckydicedesign.de', 'https://luckydicedesign.com', 'https://www.luckydicedesign.com']);
const collections = new Set(['site_settings', 'navigation_items', 'pages', 'services', 'projects', 'about_facts', 'process_steps', 'contact_channels']);
const rates = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
function reply(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
async function forward(url, method = 'GET', body) {
  return fetch(cms + url, {
    method, signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${fs.readFileSync(tokenPath, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/assets/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end('window.LDD_CONFIG = { directusUrl: "/cms", directusToken: "" };');
    }
    const match = url.pathname.match(/^\/cms\/items\/([a-z_]+)$/);
    if (req.method === 'GET' && match && collections.has(match[1])) {
      const result = await forward(`/items/${match[1]}${url.search}`);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      return res.end(await result.text());
    }
    if (req.method === 'POST' && url.pathname === '/cms/items/contact_submissions') {
      if (!origins.has(req.headers.origin)) return reply(res, 403, { error: 'Origin rejected' });
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim();
      const now = Date.now();
      for (const [key, entry] of rates) if (entry.until < now) rates.delete(key);
      const entry = rates.get(ip) || { count: 0, until: now + 600000 };
      if (++entry.count > 5) return reply(res, 429, { error: 'Please try again later' });
      rates.set(ip, entry);
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) return reply(res, 413, { error: 'Request too large' }); }
      let data;
      try { data = JSON.parse(raw); } catch { return reply(res, 400, { error: 'Invalid request' }); }
      const valid = typeof data.name === 'string' && data.name.trim().length > 0 && data.name.length <= 200 &&
        typeof data.email === 'string' && data.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) &&
        typeof data.message === 'string' && data.message.trim().length > 0 && data.message.length <= 8000 &&
        (data.project_type === undefined || typeof data.project_type === 'string' && data.project_type.length <= 200);
      if (!valid) return reply(res, 400, { error: 'Invalid fields' });
      const result = await forward('/items/contact_submissions?fields=id', 'POST', {
        name: data.name.trim(), email: data.email.trim(), message: data.message.trim(), project_type: data.project_type || '', source: 'Lucky Dice Design Website',
      });
      if (!result.ok) { console.error('Contact storage failed:', result.status); return reply(res, 502, { error: 'Storage unavailable' }); }
      return reply(res, 200, { ok: true });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed' });
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) return reply(res, 404, { error: 'Not found' });
    let target = file;
    const projectRoute = url.pathname.match(/^\/work\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
    if (projectRoute) {
      let project;
      try {
        const result = await forward(`/items/projects?filter[slug][_eq]=${encodeURIComponent(projectRoute[1])}&filter[status][_eq]=published&limit=1`);
        if (!result.ok) throw new Error('CMS unavailable');
        const payload = await result.json();
        if (!Array.isArray(payload.data)) throw new Error('Invalid CMS response');
        project = payload.data[0];
      } catch {
        const contentFile = path.join(root, 'assets/content.js');
        const snapshot = await import(`${pathToFileURL(contentFile).href}?version=${fs.statSync(contentFile).mtimeMs}`);
        project = snapshot.fallbackContent.projects.find(item => item.slug === projectRoute[1]);
      }
      if (!project) return reply(res, 404, { error: 'Project not found' });
      target = path.join(root, 'work/project/index.html');
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return reply(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Content-Length': fs.statSync(target).size });
    if (req.method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(target), res);
  } catch (error) { console.error('Request failed:', error.message); if (!res.headersSent) reply(res, 502, { error: 'Service unavailable' }); else res.destroy(); }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0');
