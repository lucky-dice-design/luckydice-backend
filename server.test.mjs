import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('gateway restricts contact fields and protects stored requests', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucky-test-'));
  fs.writeFileSync(path.join(tmp, 'token'), 'test-server-token');
  fs.mkdirSync(path.join(tmp, 'work/project'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'work/project/index.html'), '<h1>Project template</h1>');
  fs.writeFileSync(path.join(tmp, 'assets/content.js'), 'export const fallbackContent = { projects: [{ slug: "offline-project", title: "Offline project" }] };');
  const writes = [];
  const reads = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-server-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url.startsWith('/assets/')) {
      if (req.url === '/assets/11111111-1111-4111-8111-111111111111') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
      }
      res.writeHead(403); return res.end();
    }
    if (req.method === 'POST') { assert.equal(req.url, '/items/contact_submissions?fields=id'); writes.push(JSON.parse(raw)); }
    if (req.method === 'GET' && req.url.startsWith('/items/')) reads.push(new URL(req.url, 'http://test'));
    if (/^\/items\/(navigation_items|services|about_facts|process_steps|contact_channels)\?/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: req.url.startsWith('/items/navigation_items?')
        ? [{ id: 1, label: 'Home', url: '/', sort: 1, status: 'published' }] : [] }));
    }
    if (req.url.startsWith('/items/pages?')) {
      const slug = new URL(req.url, 'http://test').searchParams.get('filter[slug][_eq]');
      res.setHeader('Content-Type', 'application/json');
      if (slug === 'upstream-error') { res.writeHead(403); return res.end('{"errors":[{"internal":"do-not-expose"}]}'); }
      if (slug === 'oversized') return res.end(JSON.stringify({ data: [{ status: 'published', legal_body: 'x'.repeat(1024 * 1024) }] }));
      if (slug === 'invalid-json') return res.end('not JSON');
      if (slug === 'too-many') return res.end(JSON.stringify({ data: Array.from({ length: 101 }, () => ({ status: 'published' })) }));
      if (slug === 'nested-relation') return res.end(JSON.stringify({ data: [{ status: 'published', text: { confidential: 'hidden' } }] }));
      if (slug === null) return res.end(JSON.stringify({ data: ['home', 'work', 'about', 'contact', 'impressum', 'datenschutz']
        .map(slug => ({ slug, title: 'Public page', status: 'published', private_notes: 'hidden' })) }));
      return res.end(JSON.stringify({ data: [{ slug, title: 'Public page', status: slug === 'draft-item' ? 'draft' : 'published', private_notes: 'hidden' }], meta: { internal: 'hidden' } }));
    }
    if (req.url.startsWith('/items/projects?')) {
      const slug = new URL(req.url, 'http://test').searchParams.get('filter[slug][_eq]');
      if (slug === 'offline-project') { res.writeHead(503); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: slug === 'test-project' ? [{ slug, title: 'Test project' }] : [] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 1, site_name: 'Lucky Dice', private_notes: 'hidden' }, meta: { internal: 'hidden' } }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), DIRECTUS_URL: `http://127.0.0.1:${upstream.address().port}`, TOKEN_PATH: path.join(tmp, 'token'), SITE_ROOT: tmp }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupErrors = '';
  child.stderr.on('data', chunk => { startupErrors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, startupErrors || 'Gateway did not start');
    const submit = (origin, body) => fetch(base + '/cms/items/contact_submissions', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await submit('https://attacker.example', {})).status, 403);
    assert.equal((await submit('https://luckydicedesign.de', {})).status, 400);
    assert.equal((await submit('https://luckydicedesign.de', { name: 'Test', email: 'test@example.com', message: 'Hello', status: 'done', internal_notes: 'untrusted' })).status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].status, undefined);
    assert.equal(writes[0].internal_notes, undefined);
    assert.equal((await fetch(base + '/cms/items/contact_submissions')).status, 404);
    assert.equal((await fetch(base + '/cms/items/site_settings')).status, 200);
    assert.equal((await fetch(base + '/work/test-project/')).status, 200);
    assert.equal((await fetch(base + '/work/missing-project/')).status, 404);
    assert.equal((await fetch(base + '/work/offline-project/')).status, 200);
    const image = await fetch(base + '/cms/assets/11111111-1111-4111-8111-111111111111');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await image.arrayBuffer()).toString('hex'), '89504e470d0a1a0a');
    assert.equal((await fetch(base + '/cms/assets/22222222-2222-4222-8222-222222222222')).status, 404);
    assert.ok(!(await (await fetch(base + '/assets/config.js')).text()).includes('test-server-token'));

    await t.test('public fields and publication filters are fixed and extra response data is dropped', async () => {
      const settings = await (await fetch(base + '/cms/items/site_settings')).json();
      assert.deepEqual(settings, { data: { id: 1, site_name: 'Lucky Dice' } });
      const settingsQuery = reads.at(-1).searchParams;
      assert.equal(settingsQuery.get('fields'), 'id,site_name,footer_note,email,instagram');
      const response = await fetch(base + '/cms/items/pages?filter[slug][_eq]=home&limit=1');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: [{ slug: 'home', title: 'Public page', status: 'published' }] });
      const query = reads.at(-1).searchParams;
      assert.equal(query.get('filter[status][_eq]'), 'published');
      assert.equal(query.get('filter[slug][_eq]'), 'home');
      assert.equal(query.get('limit'), '1');
      assert.equal(query.get('sort'), 'id');
      assert.ok(!query.get('fields').includes('*'));
      for (const collection of ['navigation_items', 'services', 'projects']) {
        await fetch(base + `/cms/items/${collection}?filter[status][_eq]=published&sort=sort`);
        assert.equal(reads.at(-1).searchParams.get('filter[status][_eq]'), 'published');
      }
    });

    await t.test('field expansion, arbitrary filters, duplicates and unbounded pagination never reach CMS', async () => {
      const before = reads.length;
      for (const query of ['fields=*', 'fields=*,screenshot.*', 'deep[x][_limit]=-1', 'aggregate[count]=*',
        'search=secret', 'filter={}', 'filter[status][_eq]=draft', 'filter[slug][_eq]=../escape',
        'limit=-1', 'limit=101', 'limit=0', 'limit=1&limit=2', 'offset=-1', 'offset=10000',
        'sort=-id', 'page=100', 'meta=*']) {
        assert.equal((await fetch(base + `/cms/items/projects?${query}`)).status, 400, query);
      }
      assert.equal((await fetch(base + '/cms/items/site_settings?limit=1')).status, 400);
      assert.equal((await fetch(base + '/cms/items/about_facts?filter[slug][_eq]=home')).status, 400);
      assert.equal((await fetch(base + '/cms/items/pages?x=' + 'a'.repeat(2050))).status, 414);
      assert.equal(reads.length, before);
    });

    await t.test('allowed pagination retains deterministic order with a bounded page size', async () => {
      assert.equal((await fetch(base + '/cms/items/projects?limit=25&offset=100&sort=sort')).status, 200);
      const query = reads.at(-1).searchParams;
      assert.equal(query.get('limit'), '25');
      assert.equal(query.get('offset'), '100');
      assert.equal(query.get('sort'), 'sort,id');
    });

    await t.test('upstream errors, excessive responses, relations and unpublished rows are not exposed', async () => {
      for (const slug of ['upstream-error', 'oversized', 'invalid-json', 'too-many', 'nested-relation', 'draft-item']) {
        const response = await fetch(base + `/cms/items/pages?filter[slug][_eq]=${slug}`);
        assert.equal(response.status, 502, slug);
        const body = await response.text();
        assert.ok(!body.includes('do-not-expose'));
        assert.ok(!body.includes('hidden'));
        assert.ok(!body.includes('test-server-token'));
      }
    });

    await t.test('complete content export works through the restricted gateway without private metadata', async () => {
      const syncChild = spawn(process.execPath, [fileURLToPath(new URL('./sync-content.mjs', import.meta.url))], {
        env: { ...process.env, CONTENT_GATEWAY: base }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      syncChild.stdout.on('data', chunk => { output += chunk; });
      syncChild.stderr.on('data', chunk => { errors += chunk; });
      const [code] = await once(syncChild, 'exit');
      assert.equal(code, 0, errors);
      const content = JSON.parse(output.trim().slice('export const fallbackContent = '.length, -1));
      assert.equal(content.settings.site_name, 'Lucky Dice');
      assert.equal(Object.keys(content.pages).length, 6);
      assert.equal(content.navigation[0].url, '/');
      assert.ok(!output.includes('private_notes'));
      assert.ok(!output.includes('test-server-token'));
    });

    await t.test('public reads are rate limited before making more authenticated CMS requests', async () => {
      const before = reads.length;
      for (let i = 0; i <= 120; i++) {
        const response = await fetch(base + '/cms/items/site_settings', { headers: { 'X-Forwarded-For': '198.51.100.20' } });
        assert.equal(response.status, i < 120 ? 200 : 429);
        await response.arrayBuffer();
      }
      assert.equal(reads.length - before, 120);
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('content sync paginates complete collections instead of requesting unlimited results', async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test');
    requests.push(url);
    const collection = url.pathname.split('/').at(-1);
    let data = [];
    if (collection === 'site_settings') data = { site_name: 'Test site' };
    else {
      assert.equal(url.searchParams.get('limit'), '100');
      const offset = Number(url.searchParams.get('offset'));
      if (collection === 'projects') data = Array.from({ length: Math.max(0, Math.min(100, 150 - offset)) }, (_, index) => ({ slug: `project-${offset + index}` }));
      if (collection === 'pages') data = ['home', 'work', 'about', 'contact', 'impressum', 'datenschutz'].map(slug => ({ slug }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./sync-content.mjs', import.meta.url))], {
      env: { ...process.env, CONTENT_GATEWAY: `http://127.0.0.1:${upstream.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, errors);
    const content = JSON.parse(output.trim().slice('export const fallbackContent = '.length, -1));
    assert.equal(content.projects.length, 150);
    assert.equal(content.projects[149].slug, 'project-149');
    assert.deepEqual(requests.filter(url => url.pathname.endsWith('/projects')).map(url => url.searchParams.get('offset')), ['0', '100']);
    assert.ok(!requests.some(url => url.searchParams.get('limit') === '-1'));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => upstream.close(resolve));
  }
});
