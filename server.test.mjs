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
  const writes = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-server-token');
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.method === 'POST') { assert.equal(req.url, '/items/contact_submissions?fields=id'); writes.push(JSON.parse(raw)); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { id: 1, site_name: 'Lucky Dice' } }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), DIRECTUS_URL: `http://127.0.0.1:${upstream.address().port}`, TOKEN_PATH: path.join(tmp, 'token'), SITE_ROOT: tmp }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const submit = (origin, body) => fetch(base + '/cms/items/contact_submissions', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await submit('https://attacker.example', {})).status, 403);
    assert.equal((await submit('https://luckydicedesign.de', {})).status, 400);
    assert.equal((await submit('https://luckydicedesign.de', { name: 'Test', email: 'test@example.com', message: 'Hello', status: 'done', internal_notes: 'untrusted' })).status, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].status, undefined);
    assert.equal(writes[0].internal_notes, undefined);
    assert.equal((await fetch(base + '/cms/items/contact_submissions')).status, 404);
    assert.equal((await fetch(base + '/cms/items/site_settings')).status, 200);
    assert.ok(!(await (await fetch(base + '/assets/config.js')).text()).includes('test-server-token'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
