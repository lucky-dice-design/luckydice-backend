const base = process.env.CONTENT_GATEWAY || 'http://127.0.0.1:3000';
async function read(collection, sorted = true) {
  const singleton = collection === 'site_settings';
  const items = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const params = new URLSearchParams(singleton ? {} : { limit: '100', offset: String(offset), ...(sorted ? { sort: 'sort' } : {}) });
    const response = await fetch(`${base}/cms/items/${collection}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Content sync failed: ${collection} (${response.status})`);
    const { data } = await response.json();
    if (data === null || data === undefined) throw new Error(`Missing CMS content: ${collection}`);
    if (singleton) return data;
    if (!Array.isArray(data) || data.length > 100) throw new Error(`Invalid CMS response: ${collection}`);
    items.push(...data);
    if (data.length < 100) return items;
  }
  throw new Error(`Content sync limit reached: ${collection}`);
}
try {
  const settings = await read('site_settings', false);
  const navigation = await read('navigation_items');
  const pageItems = await read('pages', false);
  const services = await read('services');
  const projects = await read('projects');
  const facts = await read('about_facts');
  const processSteps = await read('process_steps');
  const contactLines = await read('contact_channels');
  if (typeof settings.site_name !== 'string' || !settings.site_name.trim()) throw new Error('Missing site name');
  for (const list of [navigation, pageItems, services, projects, facts, processSteps, contactLines]) {
    if (!Array.isArray(list)) throw new Error('Invalid CMS collection response');
  }
  const pages = Object.fromEntries(pageItems.map(page => [page.slug, page]));
  if (!['home', 'work', 'about', 'contact', 'impressum', 'datenschutz'].every(slug => pages[slug])) throw new Error('Required published page missing');
  const content = { settings, navigation, pages, services, projects, facts, process: processSteps, contactLines };
  process.stdout.write(`export const fallbackContent = ${JSON.stringify(content, null, 2)};\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
