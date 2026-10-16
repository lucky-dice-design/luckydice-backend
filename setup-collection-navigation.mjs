import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Folder collections organize the Data Studio; schema:null creates no SQL table.
export const navigationGroups = [
  {
    collection: "nav_website", label: "Website & Einstellungen", icon: "language",
    children: [
      ["pages", "Seiten & Rechtstexte", "article"],
      ["navigation_items", "Menü & Navigation", "menu"],
      ["site_settings", "Website-Einstellungen", "settings"],
    ],
  },
  {
    collection: "nav_portfolio", label: "Portfolio & Leistungen", icon: "work",
    children: [
      ["projects", "Projekte & Referenzen", "web"],
      ["services", "Leistungen", "design_services"],
    ],
  },
  {
    collection: "nav_about", label: "Über mich & Ablauf", icon: "person",
    children: [
      ["about_facts", "Über mich: Fakten", "badge"],
      ["process_steps", "Zusammenarbeit & Ablauf", "format_list_numbered"],
    ],
  },
  {
    collection: "nav_contact", label: "Kontakt & Anfragen", icon: "contact_mail",
    children: [
      ["contact_submissions", "Eingegangene Anfragen", "inbox"],
      ["contact_channels", "Kontaktwege", "alternate_email"],
    ],
  },
];

function translationsFor(existing, label) {
  // Keep other languages and optional singular/plural translations intact.
  const translations = structuredClone(existing || []);
  for (const language of ["de-DE", "en-US"]) {
    const entry = translations.find((item) => item.language === language);
    if (entry) entry.translation = label;
    else translations.push({ language, translation: label });
  }
  return translations;
}

export function planCollectionNavigation(collections) {
  const existing = new Map(collections.map((item) => [item.collection, item]));
  const operations = [];
  const skipped = [];
  const patch = (collection, desired) => {
    const current = existing.get(collection)?.meta || {};
    const meta = Object.fromEntries(Object.entries(desired).filter(
      ([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value),
    ));
    if (Object.keys(meta).length) {
      operations.push({ method: "PATCH", path: `/collections/${collection}`, body: { meta } });
    }
  };

  // Validate all reserved names before planning any writes.
  for (const group of navigationGroups) {
    if (existing.has(group.collection) && existing.get(group.collection).schema !== null) {
      throw new Error(`${group.collection}: Gruppenname ist bereits durch eine Datentabelle belegt.`);
    }
    for (const [name] of group.children) {
      if (existing.has(name) && !existing.get(name).schema) {
        throw new Error(`${name}: Erwartete Inhalts-Collection ist keine Datentabelle.`);
      }
    }
  }

  for (const [groupIndex, group] of navigationGroups.entries()) {
    const children = group.children.filter(([name]) => {
      if (existing.has(name)) return true;
      skipped.push(name);
      return false;
    });
    // An incremental installation may not have every content module yet.
    if (!children.length) continue;
    const meta = {
      icon: group.icon, group: null, sort: groupIndex + 1,
      translations: translationsFor(existing.get(group.collection)?.meta?.translations, group.label),
    };
    if (existing.has(group.collection)) patch(group.collection, meta);
    else operations.push({
      method: "POST", path: "/collections",
      body: { collection: group.collection, schema: null, meta: { ...meta, hidden: false, collapse: "open" } },
    });
    for (const [index, [name, label, icon]] of children.entries()) {
      patch(name, {
        icon, group: group.collection, sort: index + 1,
        translations: translationsFor(existing.get(name)?.meta?.translations, label),
      });
    }
  }
  return { operations, skipped };
}

export async function applyCollectionNavigation(request, { dryRun = false, log = console.log } = {}) {
  const collections = await request("/collections");
  const plan = planCollectionNavigation(collections);
  for (const operation of plan.operations) {
    log(`${dryRun ? "Vorschau" : "Navigation"}: ${operation.method} ${operation.body.collection || operation.path.slice("/collections/".length)}`);
    if (!dryRun) await request(operation.path, operation.method, operation.body);
  }
  if (plan.skipped.length) log(`Noch nicht eingerichtet, übersprungen: ${plan.skipped.join(", ")}`);
  log(`${plan.operations.length} Navigationsänderungen ${dryRun ? "geplant" : "angewendet"}.`);
  return plan;
}

async function prompt(label, hidden = false) {
  const output = hidden ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: true });
  if (hidden) process.stdout.write(label);
  try { return await input.question(hidden ? "" : label); }
  finally { input.close(); if (hidden) process.stdout.write("\n"); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--dry-run", "--env-auth"].includes(arg))) {
    throw new Error("Aufruf: node setup-collection-navigation.mjs [--dry-run] [--env-auth]");
  }
  let token;
  const request = async (path, method = "GET", body) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`http://127.0.0.1:8055${path}`, {
        method, signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < 4) {
        await new Promise((done) => setTimeout(done, Math.min(1000 * 2 ** attempt, 8000)));
        continue;
      }
      // Never include authentication payloads or server response bodies in errors.
      if (!response.ok) throw new Error(`Directus ${method} ${path}: HTTP ${response.status}`);
      return (await response.json()).data;
    }
  };
  let email, password;
  if (args.includes("--env-auth")) {
    email = process.env.ADMIN_EMAIL;
    password = process.env.ADMIN_PASSWORD;
    if (!email || !password) throw new Error("ADMIN_EMAIL und ADMIN_PASSWORD fehlen im Container.");
  } else {
    if (!process.stdin.isTTY) throw new Error("Für die Admin-Anmeldung ein interaktives Terminal verwenden.");
    email = await prompt("Directus-Admin-E-Mail: ");
    password = await prompt("Directus-Admin-Passwort: ", true);
  }
  const auth = await request("/auth/login", "POST", { email, password });
  token = auth.access_token;
  if (!token) throw new Error("Anmeldung fehlgeschlagen.");
  await applyCollectionNavigation(request, { dryRun: args.includes("--dry-run") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
