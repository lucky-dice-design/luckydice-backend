import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const root = process.env.SITE_ROOT || '/app/site';
const tokenPath = process.env.TOKEN_PATH || '/app/contact_token';
const cms = process.env.DIRECTUS_URL;
const origins = new Set(['https://luckydicedesign.de', 'https://www.luckydicedesign.de', 'https://luckydicedesign.com', 'https://www.luckydicedesign.com']);
const publicFields = {
  site_settings: ['id', 'site_name', 'footer_note', 'email', 'instagram'],
  navigation_items: ['id', 'label', 'url', 'sort', 'status'],
  pages: ['id', 'slug', 'status', 'meta_title', 'meta_description', 'title', 'text', 'legal_body', 'hero_title', 'hero_text', 'intro_title', 'intro_text', 'sheet_eyebrow', 'sheet_title', 'sheet_intro', 'sheet_portrait', 'sheet_portrait_alt', 'sheet_portrait_placeholder', 'sheet_portrait_caption', 'sheet_identity_label', 'sheet_identity', 'sheet_roll_label', 'sheet_dice_label', 'sheet_dice_hint', 'sheet_roll_result_label', 'sheet_roll_pending_label', 'sheet_roll_bonus_label', 'sheet_roll_outcomes', 'sheet_discovery_label', 'sheet_discovery_link', 'sheet_discoveries', 'sheet_skills_title', 'sheet_skills_hint', 'sheet_skills', 'sheet_inventory_title', 'sheet_inventory', 'sheet_approach_title', 'sheet_approach', 'sheet_quests_title', 'sheet_projects_tab', 'sheet_process_tab', 'sheet_project_link', 'sheet_project_empty', 'sheet_next_title', 'sheet_next_text', 'sheet_next_link', 'sheet_personal_title', 'sheet_personal_intro', 'sheet_personal_open_label', 'sheet_personal', 'sheet_personal_empty', 'sheet_twitch_channel', 'sheet_twitch_link_label', 'sheet_twitch_load_label', 'sheet_twitch_notice', 'sheet_twitch_player_title', 'sheet_cta_eyebrow', 'sheet_cta_title', 'sheet_cta_text', 'sheet_cta_label', 'sheet_cta_url', 'sheet_brand_label', 'sheet_menu_label', 'sheet_navigation_label', 'sheet_theme_label', 'sheet_light_label', 'sheet_dark_label', 'sheet_legal_label', 'sheet_privacy_label'],
  services: ['id', 'status', 'sort', 'number', 'title', 'text'],
  projects: ['id', 'slug', 'website_url', 'detail_body', 'screenshot', 'screenshot_alt', 'status', 'sort', 'title', 'type', 'year', 'text', 'highlight'],
  about_facts: ['id', 'sort', 'label', 'value'],
  process_steps: ['id', 'sort', 'title', 'text'],
  contact_channels: ['id', 'sort', 'label', 'value', 'url'],
};
// Only these flat editorial keys may pass through JSON repeater fields.
const aboutListFields = {
  "sheet_identity": [
    "title",
    "text"
  ],
  "sheet_roll_outcomes": [
    "min",
    "max",
    "title",
    "text",
    "target",
    "bonus_text"
  ],
  "sheet_discoveries": [
    "title",
    "text",
    "target"
  ],
  "sheet_skills": [
    "title",
    "text",
    "link_label",
    "url",
    "icon"
  ],
  "sheet_inventory": [
    "title",
    "text",
    "icon"
  ],
  "sheet_approach": [
    "title",
    "text",
    "icon"
  ],
  "sheet_personal": [
    "title",
    "text",
    "link_label",
    "url",
    "teaser",
    "twitch",
    "icon"
  ]
};
const collections = new Set(Object.keys(publicFields));
const publishedCollections = new Set(['navigation_items', 'pages', 'services', 'projects']);
const sortedCollections = new Set(['navigation_items', 'services', 'projects', 'about_facts', 'process_steps', 'contact_channels']);
const maxRows = 100;
const maxOffset = 9900;
const maxCmsBytes = 1024 * 1024;
const readRates = new Map();
let nextReadSweep = 0;
const rates = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
function reply(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
function allowRead(req) {
  const now = Date.now();
  if (now >= nextReadSweep) {
    for (const [ip, entry] of readRates) if (entry.until <= now) readRates.delete(ip);
    nextReadSweep = now + 1000;
  }
  // The website port is internal; Caddy appends the actual peer to this header.
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim();
  let entry = readRates.get(ip);
  if (!entry || entry.until <= now) {
    if (!entry && readRates.size >= 10000) return false;
    entry = { count: 0, until: now + 60000 };
    readRates.set(ip, entry);
  }
  return ++entry.count <= 120;
}
function publicQuery(collection, search) {
  const allowed = new Set(['limit', 'offset', 'sort', 'filter[status][_eq]', 'filter[slug][_eq]']);
  for (const key of search.keys()) {
    if (!allowed.has(key) || search.getAll(key).length !== 1) throw new Error('Unsupported query');
  }
  const limit = search.get('limit') ?? String(maxRows);
  const offset = search.get('offset') ?? '0';
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > maxRows ||
      !/^(0|[1-9][0-9]{0,3})$/.test(offset) || Number(offset) > maxOffset) throw new Error('Invalid pagination');
  if (search.has('sort') && (!sortedCollections.has(collection) || search.get('sort') !== 'sort')) throw new Error('Invalid sort');
  if (search.has('filter[status][_eq]') &&
      (!publishedCollections.has(collection) || search.get('filter[status][_eq]') !== 'published')) throw new Error('Invalid status');
  const slug = search.get('filter[slug][_eq]');
  if (slug !== null && (!['pages', 'projects'].includes(collection) ||
      slug.length > 180 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) throw new Error('Invalid slug');
  const params = new URLSearchParams({ fields: publicFields[collection].join(',') });
  if (collection === 'site_settings') {
    if (search.size) throw new Error('Singleton query parameters are not supported');
  } else {
    params.set('limit', limit);
    params.set('offset', offset);
    params.set('sort', sortedCollections.has(collection) ? 'sort,id' : 'id');
  }
  if (publishedCollections.has(collection)) params.set('filter[status][_eq]', 'published');
  if (slug !== null) params.set('filter[slug][_eq]', slug);
  return { path: `/items/${collection}?${params}`, limit: Number(limit) };
}
async function cmsJson(result) {
  const chunks = [];
  let size = 0;
  for await (const chunk of result.body) {
    size += chunk.length;
    if (size > maxCmsBytes) throw new Error('CMS response exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function publicData(collection, data, limit) {
  const project = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid CMS item');
    if (publishedCollections.has(collection) && item.status !== 'published') throw new Error('Unexpected unpublished CMS item');
    const output = {};
    for (const field of publicFields[collection]) {
      if (!Object.hasOwn(item, field)) continue;
      if (field.startsWith('sheet_') && item.slug !== 'about') continue;
      const value = item[field];
      if (value !== null && aboutListFields[field]) {
        if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid About list');
        output[field] = value.map(row => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid About entry');
          const entry = {};
          for (const key of aboutListFields[field]) {
            if (!Object.hasOwn(row, key)) continue;
            const cell = row[key];
            if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) throw new Error('Unexpected About relation');
            entry[key] = cell;
          }
          return entry;
        });
        continue;
      }
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Unexpected CMS relation');
      output[field] = value;
    }
    return output;
  };
  if (collection === 'site_settings') return project(data);
  if (!Array.isArray(data) || data.length > limit) throw new Error('Invalid CMS collection');
  return data.map(project);
}
async function forward(url, method = 'GET', body) {
  return fetch(cms + url, {
    method, signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${fs.readFileSync(tokenPath, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
http.createServer(async (req, res) => {
  try {
    if (req.url.length > 2048) return reply(res, 414, { error: 'URL too long' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/assets/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end('window.LDD_CONFIG = { directusUrl: "/cms", directusToken: "" };');
    }
    const match = url.pathname.match(/^\/cms\/items\/([a-z_]+)$/);
    const asset = url.pathname.match(/^\/cms\/assets\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
    if (['GET', 'HEAD'].includes(req.method) && asset) {
      if (!allowRead(req)) return reply(res, 429, { error: 'Please try again later' });
      const result = await forward(`/assets/${asset[1]}`);
      if (!result.ok) return reply(res, result.status === 403 ? 404 : result.status, { error: 'Screenshot unavailable' });
      const mime = result.headers.get('content-type')?.split(';')[0];
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(mime)) return reply(res, 415, { error: 'Unsupported screenshot format' });
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { await result.body.cancel(); return res.end(); }
      await pipeline(Readable.fromWeb(result.body), res);
      return;
    }
    if (req.method === 'GET' && match && collections.has(match[1])) {
      if (!allowRead(req)) return reply(res, 429, { error: 'Please try again later' });
      let query;
      try { query = publicQuery(match[1], url.searchParams); }
      catch { return reply(res, 400, { error: 'Unsupported content query' }); }
      const result = await forward(query.path);
      if (!result.ok) {
        await result.body?.cancel();
        return reply(res, 502, { error: 'Content unavailable' });
      }
      const payload = await cmsJson(result);
      return reply(res, 200, { data: publicData(match[1], payload.data, query.limit) });
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
      if (!allowRead(req)) return reply(res, 429, { error: 'Please try again later' });
      let project;
      try {
        const result = await forward(`/items/projects?fields=slug&filter[slug][_eq]=${encodeURIComponent(projectRoute[1])}&filter[status][_eq]=published&limit=1`);
        if (!result.ok) throw new Error('CMS unavailable');
        const payload = await cmsJson(result);
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
