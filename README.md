# VPS Deployment

Die gruppierte Directus-Navigation mit Anzeigenamen und Icons ist in
[COLLECTIONS.md](COLLECTIONS.md) beschrieben. Das reguläre Setup aktualisiert
sie auch für bereits vorhandene Collections.

The installation uses the existing Himmelsteil Caddy container and its web network.
Lucky Dice has its own PostgreSQL database, Directus instance and website service.
Nothing is cloned from GitHub on the VPS. Files are uploaded by SSH.

This repository contains the backend release files. The static frontend is
maintained in `lucky-dice-design/luckydice-frontend`. Real `.env` files, uploaded files,
database storage and service keys are excluded from Git.

Upload this directory as `backend` and the website `dist` as `frontend/dist`
into `/home/timo/luckydice-release`. Copy `directus/schema.json` and
`directus/seed.json` into the release backend directory.

Run on the VPS:

```bash
sudo bash /home/timo/luckydice-release/backend/install.sh
```

The script asks for the administrator email and prints a generated initial
password on first installation. Credentials stay in the root-only backend `.env`.
The installer can be rerun without replacing credentials or existing CMS content.
It backs up and validates Caddy before reloading. A failed reload restores the
previous configuration. Database setup is additive; existing content is retained.

Directus 12 requires a licensed tier for custom access policies. Qualifying
individuals and organizations can apply at https://directus.com/oig. Once the
key is available, enter it privately on the VPS:

```bash
sudo bash /home/timo/luckydice-release/backend/install.sh --license
```

The key is stored in the root-only `.env`, passed as `LICENSE_KEY`, and is not
printed by the installer. Do not put it in Git or send it in chat.

Website content uses a same-origin `/cms` gateway. The restricted service token
stays on the server; browsers receive no token. Contact requests are validated,
rate limited, and stored in `contact_submissions`. Visitors cannot read enquiries
or change their status or internal notes. Emails are not sent automatically.

For `luckydicedesign.de`, `www.luckydicedesign.de`, `luckydicedesign.com`,
`www.luckydicedesign.com` and `admin.luckydicedesign.de`, use DNS A records
pointing at `212.227.161.13`. Remove conflicting AAAA records if this VPS has no
configured IPv6 endpoint. Keep mail DNS records unchanged.

This does not publish or change the ChatGPT Sites deployment. It serves the
current static export on the VPS. Site content still contains portfolio and
contact placeholders that should be edited in Directus before launch.

## Legal Pages

## Project Detail Pages

In `projects`, set `slug` (for example `himmelsteil`), `website_url` and
`detail_body`. Detail URLs are `/work/<slug>/`. Existing projects receive a
unique slug on setup; existing slugs and descriptions are retained. Blank
website URLs hide the external link. Only published projects are served;
unknown slugs return HTTP 404. During a CMS outage, routes use the last
successful cron export. The website container is recreated on deployment
so its routing changes are loaded.

Upload a PNG, JPEG, WebP or AVIF via `projects.screenshot` and describe it with
`screenshot_alt`. The frontend uses the same-origin `/cms/assets/<id>` gateway;
service tokens are never included in image URLs. The file read policy only
allows images referenced by a published project. Draft or unrelated files stay
private. The screenshot remains in its original aspect ratio and can be opened
at its original size.

## Legal Page Content

In Directus, edit `pages` with slugs `impressum` and `datenschutz`.
The `title`, `text`, `legal_body`, `meta_title` and `meta_description` fields
control their content. `legal_body` is plain text with preserved line breaks;
HTML is intentionally not rendered. Defaults are clearly marked placeholders,
not completed legal documents. Re-running setup creates missing pages without
overwriting existing texts, and updates the website read grant for new fields.

## Automatic Content Sync

The frontend reads CMS content on every page load. A separate five-minute cron
job also exports published content into its local fallback module. The sync does
not export contact submissions, tokens, users or drafts. A failed export retains
the last successful file, and a file lock prevents overlapping runs.

Upload the `sync-content` files, cron definition, logrotate definition and
`install-sync.sh` to the backend release directory, then run:

```bash
sudo bash /home/timo/luckydice-release/backend/install-sync.sh
```

This performs the first sync before enabling `/etc/cron.d/luckydice-content`.
Logs are in `/var/log/luckydice-content.log` and rotate weekly.

## Static file permissions

The website container runs as uid/gid 1000:1000. After copying the release,
the installer sets public frontend directories to 0755 and files to 0644.
Uploads may preserve mode 0700 on dist. The installer checks readability
using the website service user before recreating it, and checks the actual
HTML homepage after startup in addition to the CMS gateway.

If the live homepage returns a JSON Not found error because the root-owned
static directory has mode 0700, repair only the public frontend tree:

```bash
sudo find /opt/luckydicedesign/frontend/dist -type d -exec chmod 0755 {} +
sudo find /opt/luckydicedesign/frontend/dist -type f -exec chmod 0644 {} +
curl -fsSI https://luckydicedesign.de/
```

No restart is required. Do not apply these permissions to the backend,
.env, or secrets.

## Automatisches VPS-Deployment

Prüfungen und Deployment per GitHub Actions sind unter [deploy/README.md](deploy/README.md) beschrieben. Die einmalige Einrichtung auf GitHub und dem VPS ist vor der Aktivierung erforderlich.
