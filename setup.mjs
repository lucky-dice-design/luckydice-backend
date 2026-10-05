import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const base = 'http://127.0.0.1:8055';
let token;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    const errors = (result.errors || []).map(error => ({
      message: error.message,
      code: error.extensions?.code,
      collection: error.extensions?.collection,
      field: error.extensions?.field,
      reason: error.extensions?.reason,
    }));
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(errors)}`);
  }
  return result.data;
}
token = (await api('/auth/login', 'POST', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })).access_token;
const schema = JSON.parse(fs.readFileSync(process.env.SCHEMA_PATH || '/opt/lucky/schema.json', 'utf8'));
const seeds = JSON.parse(fs.readFileSync(process.env.SEED_PATH || '/opt/lucky/seed.json', 'utf8'));
const existing = new Set((await api('/collections')).map(item => item.collection));
for (const definition of schema.collections) {
  const name = definition.collection;
  if (!existing.has(name)) {
    await api('/collections', 'POST', { collection: name, schema: {}, meta: { singleton: definition.type === 'singleton', icon: name === 'contact_submissions' ? 'inbox' : 'article' } });
  }
  const fields = new Set((await api(`/fields/${name}`)).map(item => item.field));
  for (const field of definition.fields) {
    if (fields.has(field.field)) continue;
    await api(`/fields/${name}`, 'POST', {
      field: field.field, type: field.type,
      meta: {
        interface: field.type === 'text' ? 'input-multiline' : field.type === 'boolean' ? 'boolean' : 'input', required: Boolean(field.required),
        ...(name === 'projects' && field.field === 'slug' ? { note: 'URL-Kennung, z. B. himmelsteil. Nur Kleinbuchstaben, Zahlen und Bindestriche; ergibt /work/himmelsteil/.' } : {}),
        ...(name === 'projects' && field.field === 'website_url' ? { note: 'Vollständige Projektwebsite mit https://. Leer lassen, um den externen Link auszublenden.' } : {}),
        ...(name === 'projects' && field.field === 'detail_body' ? { note: 'Ausführliche Projektbeschreibung; Absätze mit Leerzeilen trennen.' } : {}),
      },
      schema: { ...(field.default === undefined ? {} : { default_value: field.default }), ...(field.unique ? { is_unique: true } : {}) },
    });
  }
  if (!seeds[name]) continue;
  const current = await api(`/items/${name}?fields=id&limit=1`);
  if (definition.type === 'singleton') {
    if (!current?.id) await api(`/items/${name}`, 'PATCH', seeds[name]);
  } else if (name === 'pages') {
    const known = new Set((await api('/items/pages?fields=slug&limit=-1')).map(page => page.slug));
    for (const page of seeds.pages) if (!known.has(page.slug)) await api('/items/pages', 'POST', page);
  } else if (!current.length) await api(`/items/${name}`, 'POST', seeds[name]);
}
const projects = await api('/items/projects?fields=id,title,slug&limit=-1');
const usedSlugs = new Set(projects.map(project => project.slug).filter(Boolean));
for (const project of projects) {
  if (project.slug) continue;
  const baseSlug = (project.title || 'projekt').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180) || 'projekt';
  let slug = baseSlug;
  if (usedSlugs.has(slug)) slug = `${baseSlug}-${project.id}`;
  usedSlugs.add(slug);
  await api(`/items/projects/${project.id}`, 'PATCH', { slug });
}
// Keep the confirmed company mailbox in sync for installations seeded earlier.
const companyEmail = seeds.site_settings.email;
const settings = await api('/items/site_settings?fields=email');
if (settings.email !== companyEmail) await api('/items/site_settings', 'PATCH', { email: companyEmail });
const mailChannels = await api('/items/contact_channels?fields=id,value,url&limit=-1');
for (const channel of mailChannels) {
  if (channel.url?.startsWith('mailto:') && (channel.value !== companyEmail || channel.url !== `mailto:${companyEmail}`)) {
    await api(`/items/contact_channels/${channel.id}`, 'PATCH', { value: companyEmail, url: `mailto:${companyEmail}` });
  }
}
let policy = (await api('/policies?filter[name][_eq]=Lucky%20Website')).at(0);
if (!policy) policy = await api('/policies', 'POST', { name: 'Lucky Website', admin_access: false, app_access: false });
if (policy.admin_access || policy.app_access) throw new Error('Website policy unexpectedly grants administrator access');
const grants = await api(`/permissions?filter[policy][_eq]=${policy.id}&limit=-1`);
for (const definition of schema.collections) {
  const collection = definition.collection;
  const contact = collection === 'contact_submissions';
  const action = contact ? 'create' : 'read';
  const existingGrant = grants.find(item => item.collection === collection && item.action === action);
  console.log(`Configuring permission: ${collection}/${action}`);
  await api(existingGrant ? `/permissions/${existingGrant.id}` : '/permissions', existingGrant ? 'PATCH' : 'POST', {
    policy: policy.id, collection, action,
    fields: contact ? ['name', 'email', 'project_type', 'message', 'source'] : ['id', ...definition.fields.map(field => field.field)],
    permissions: !contact && definition.fields.some(field => field.field === 'status') ? { status: { _eq: 'published' } } : null,
    ...(contact ? { presets: { status: 'new' } } : {}),
  });
}
if (!grants.some(item => item.collection === 'contact_submissions' && item.action === 'read')) {
  await api('/permissions', 'POST', { policy: policy.id, collection: 'contact_submissions', action: 'read', fields: ['id'], permissions: null });
}
let user = (await api('/users?filter[email][_eq]=website-service%40luckydicedesign.de')).at(0);
const serviceToken = fs.existsSync('/opt/lucky/secrets/contact_token') && fs.readFileSync('/opt/lucky/secrets/contact_token', 'utf8').trim() || randomBytes(32).toString('hex');
if (!user) user = await api('/users', 'POST', {
  email: 'website-service@luckydicedesign.de', password: randomBytes(32).toString('hex'), status: 'active', token: serviceToken,
  policies: [{ policy: policy.id }],
});
else await api(`/users/${user.id}`, 'PATCH', { token: serviceToken });
fs.writeFileSync('/opt/lucky/secrets/contact_token', serviceToken, { mode: 0o640 });
console.log('Lucky Dice collections, content and restricted website access are ready.');
