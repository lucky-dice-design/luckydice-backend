import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { applyCollectionNavigation, navigationGroups } from "./setup-collection-navigation.mjs";

const names = navigationGroups.flatMap((group) => group.children.map(([name]) => name));
const quiet = { log() {} };

function fixture() {
  const collections = names.map((collection) => ({
    collection, schema: { name: collection },
    meta: {
      icon: "old_icon", hidden: collection.includes("request") || collection.includes("submission"),
      singleton: collection === "home_page" || collection === "site_settings",
      sort_field: "sort", note: "Existing editorial note", color: "#123456",
      translations: [
        { language: "fr-FR", translation: "Keep French" },
        { language: "de-DE", translation: "Old title", singular: "Keep singular", plural: "Keep plural" },
      ],
    },
  }));
  collections.push({ collection: "custom_collection", schema: {}, meta: { icon: "star", group: null } });
  const calls = [];
  const request = async (path, method = "GET", body) => {
    calls.push({ path, method, body: structuredClone(body) });
    if (path === "/collections" && method === "GET") return structuredClone(collections);
    if (path === "/collections" && method === "POST") {
      assert.equal(body.schema, null, "Only virtual folders may be created");
      assert.ok(!collections.some((item) => item.collection === body.collection));
      collections.push(structuredClone(body));
      return;
    }
    assert.equal(method, "PATCH");
    assert.match(path, /^\/collections\/[a-z_]+$/);
    assert.deepEqual(Object.keys(body), ["meta"]);
    const item = collections.find((item) => item.collection === path.split("/").at(-1));
    assert.ok(item);
    Object.assign(item.meta, structuredClone(body.meta));
  };
  return { collections, calls, request };
}

test("organizes existing collections without changing content metadata or unrelated collections", async () => {
  const state = fixture();
  const original = structuredClone(state.collections);
  await applyCollectionNavigation(state.request, quiet);
  assert.equal(state.calls.filter((call) => call.method === "POST").length, navigationGroups.length);
  for (const [groupIndex, group] of navigationGroups.entries()) {
    const folder = state.collections.find((item) => item.collection === group.collection);
    assert.equal(folder.schema, null);
    assert.equal(folder.meta.sort, groupIndex + 1);
    assert.equal(folder.meta.icon, group.icon);
    assert.equal(folder.meta.group, null);
    for (const [index, [name, label, icon]] of group.children.entries()) {
      const collection = state.collections.find((item) => item.collection === name);
      const before = original.find((item) => item.collection === name);
      assert.equal(collection.meta.group, group.collection);
      assert.equal(collection.meta.icon, icon);
      assert.equal(collection.meta.sort, index + 1);
      assert.deepEqual(collection.schema, before.schema);
      for (const key of ["hidden", "singleton", "sort_field", "note", "color"]) {
        assert.deepEqual(collection.meta[key], before.meta[key], key);
      }
      assert.deepEqual(collection.meta.translations.find((item) => item.language === "de-DE"), {
        language: "de-DE", translation: label, singular: "Keep singular", plural: "Keep plural",
      });
      assert.equal(collection.meta.translations.find((item) => item.language === "fr-FR").translation, "Keep French");
    }
  }
  assert.deepEqual(state.collections.find((item) => item.collection === "custom_collection"), original.at(-1));
});

test("rerunning is a no-op and preserves the existing folder display preference", async () => {
  const state = fixture();
  await applyCollectionNavigation(state.request, quiet);
  const folder = state.collections.find((item) => item.collection === navigationGroups[0].collection);
  folder.meta.collapse = "closed";
  folder.meta.color = "#abcdef";
  state.calls.length = 0;
  const result = await applyCollectionNavigation(state.request, quiet);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(state.calls.map((call) => call.method), ["GET"]);
  assert.equal(folder.meta.collapse, "closed");
  assert.equal(folder.meta.color, "#abcdef");
});

test("dry-run does not write any metadata", async () => {
  const state = fixture();
  const before = structuredClone(state.collections);
  const result = await applyCollectionNavigation(state.request, { ...quiet, dryRun: true });
  assert.ok(result.operations.length > 0);
  assert.deepEqual(state.calls.map((call) => call.method), ["GET"]);
  assert.deepEqual(state.collections, before);
});

test("a reserved group name occupied by a real table stops all writes", async () => {
  const state = fixture();
  const collection = navigationGroups.at(-1).collection;
  state.collections.push({ collection, schema: { name: collection }, meta: {} });
  await assert.rejects(applyCollectionNavigation(state.request, quiet), /durch eine Datentabelle belegt/);
  assert.deepEqual(state.calls.map((call) => call.method), ["GET"]);
});

test("a content name occupied by a folder stops all writes", async () => {
  const state = fixture();
  state.collections[0].schema = null;
  await assert.rejects(applyCollectionNavigation(state.request, quiet), /keine Datentabelle/);
  assert.deepEqual(state.calls.map((call) => call.method), ["GET"]);
});

test("incremental installs skip missing modules without creating empty folders", async () => {
  const state = fixture();
  const absent = navigationGroups.at(-1);
  for (const [name] of absent.children) {
    state.collections.splice(state.collections.findIndex((item) => item.collection === name), 1);
  }
  const result = await applyCollectionNavigation(state.request, quiet);
  assert.deepEqual(result.skipped, absent.children.map(([name]) => name));
  assert.ok(!state.collections.some((item) => item.collection === absent.collection));
  assert.ok(!state.calls.some((call) => call.body?.schema && call.method === "POST"));
});

test("navigation covers each content collection in the schema exactly once", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("./schema.json", import.meta.url), "utf8"));
  assert.equal(names.length, new Set(names).size);
  assert.deepEqual([...names].sort(), schema.collections.map((item) => item.collection).sort());
});

test('Docker installer bootstraps About editors, preserves edited copy and is repeatable', async () => {
  const schema = JSON.parse(fs.readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function installAbout(api) {');
  const end = source.indexOf('\nawait installAbout(api);', start);
  assert.ok(start > 0 && end > start);
  const { runInNewContext } = await import('node:vm');
  const install = runInNewContext(source.slice(start, end) + '\ninstallAbout', { schema, URL, encodeURIComponent });
  const fields = schema.collections.find(item => item.collection === 'pages').fields.map(item => ({ ...item }));
  const retired = schema.about_bootstrap.retired_fields;
  fields.push(...retired.map(field => ({ field, type: 'text' })));
  const fileFields = [], relations = [];
  const page = { id: 3, slug: 'about', sheet_title: 'Mein eigener Text', sheet_personal: [] };
  const grants = [
    { id: 1, collection: 'pages', action: 'read', fields: ['*'] },
    { id: 2, collection: 'directus_files', action: 'read', fields: ['*'], permissions: { lucky_project_screenshots: { _some: { status: { _eq: 'published' } } } } }
  ];
  const writes = [];
  const api = async (path, method = 'GET', body) => {
    body = body && structuredClone(body);
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/fields/pages' && method === 'POST') { fields.push(body); return body; }
    if (path.startsWith('/fields/pages/') && method === 'DELETE') { const name = path.split('/').at(-1); fields.splice(fields.findIndex(item => item.field === name), 1); delete page[name]; return null; }
    if (path.startsWith('/fields/pages/') && method === 'PATCH') { const field = fields.find(item => item.field === path.split('/').at(-1)); field.meta = { ...field.meta, ...body.meta }; return field; }
    if (path === '/fields/directus_files' && method === 'POST') { fileFields.push(body); return body; }
    if (path === '/relations' && method === 'POST') { relations.push(body); return body; }
    if (path.startsWith('/permissions/') && method === 'PATCH') { Object.assign(grants.find(item => item.id === Number(path.split('/').at(-1))), body); return null; }
    if (path === '/items/pages/3' && method === 'PATCH') { Object.assign(page, body); return page; }
    if (path === '/fields/pages') return fields;
    if (path === '/fields/directus_files') return fileFields;
    if (path === '/relations') return relations;
    if (path.startsWith('/policies?')) return [{ id: 'website-policy', name: 'Lucky Website', admin_access: false, app_access: false }];
    if (path.startsWith('/permissions?')) return grants;
    if (path.startsWith('/items/pages?')) return [page];
    throw new Error('Unexpected request: ' + method + ' ' + path);
  };
  await install(api);
  assert.equal(retired.length, 10);
  assert.deepEqual(writes.filter(item => item.method === 'DELETE').map(item => item.path), retired.map(name => '/fields/pages/' + name));
  assert.ok(fields.some(item => item.field === 'title'));
  assert.ok(!retired.some(name => fields.some(item => item.field === name)));
  assert.ok(!retired.some(name => schema.collections.find(item => item.collection === 'pages').fields.some(item => item.field === name)));
  assert.equal(page.sheet_title, 'Mein eigener Text');
  assert.deepEqual(page.sheet_personal, []);
  assert.ok(page.sheet_roll_outcomes.some(item => item.min === 20 && item.bonus_text));
  assert.equal(fields.find(item => item.field === 'sheet_portrait').meta.interface, 'file-image');
  assert.equal(fields.find(item => item.field === 'sheet_personal').meta.interface, 'list');
  assert.equal(relations[0].related_collection, 'directus_files');
  assert.equal(grants[1].permissions._or[1]._and[1].lucky_about_portraits._some.status._eq, 'published');
  writes.length = 0;
  await install(api);
  assert.deepEqual(writes, []);
});

test('production Directus API helper accepts empty DELETE success and retains JSON errors', async () => {
  const source = fs.readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function api(');
  const end = source.indexOf('\ntoken = (await api(', start);
  assert.ok(start >= 0 && end > start);
  const { runInNewContext } = await import('node:vm');
  const requests = [];
  let next = new Response(null, { status: 204 });
  const fetchStub = async (url, options) => { requests.push({ url, options }); return next; };
  const api = runInNewContext(source.slice(start, end) + '\napi', { base: 'http://cms.invalid', token: 'test-token', fetch: fetchStub });
  assert.equal(await api('/fields/pages/sheet_quests_title', 'DELETE'), null);
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(requests[0].url, 'http://cms.invalid/fields/pages/sheet_quests_title');
  next = new Response(JSON.stringify({ data: { sheet_portrait: 'test-id' } }), { status: 200 });
  assert.equal((await api('/items/pages')).sheet_portrait, 'test-id');
  next = new Response(JSON.stringify({ errors: [{ message: 'Not allowed', extensions: { code: 'FORBIDDEN' } }] }), { status: 403 });
  await assert.rejects(() => api('/fields/pages/example', 'DELETE'), /403.*FORBIDDEN/);
});
