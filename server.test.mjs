import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('gateway restricts contact fields and protects stored requests', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucky-test-'));
  fs.writeFileSync(path.join(tmp, 'token'), 'test-server-token');
  fs.mkdirSync(path.join(tmp, 'work/project'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'work/project/index.html'), '<h1>Project template</h1>');
  fs.writeFileSync(path.join(tmp, 'assets/content.js'), 'export const fallbackContent = { projects: [{ slug: "offline-project", title: "Offline project" }] };');
  const writes = [];
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
    if (req.url.startsWith('/items/projects?')) {
      const slug = new URL(req.url, 'http://test').searchParams.get('filter[slug][_eq]');
      if (slug === 'offline-project') { res.writeHead(503); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: slug === 'test-project' ? [{ slug, title: 'Test project' }] : [] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 1, site_name: 'Lucky Dice' } }));
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
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
