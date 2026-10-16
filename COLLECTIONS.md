# Collection-Navigation

`setup-collection-navigation.mjs` ordnet die vorhandenen Collections im Directus
Data Studio. Technische Collection-Namen, Inhalte, Felder, Beziehungen und
Berechtigungen bleiben erhalten.

| Gruppe (Icon) | Collections mit Anzeigenamen (Icon) |
| --- | --- |
| Website & Einstellungen (`language`) | `pages`: Seiten & Rechtstexte (`article`); `navigation_items`: Menü & Navigation (`menu`); `site_settings`: Website-Einstellungen (`settings`) |
| Portfolio & Leistungen (`work`) | `projects`: Projekte & Referenzen (`web`); `services`: Leistungen (`design_services`) |
| Über mich & Ablauf (`person`) | `about_facts`: Über mich: Fakten (`badge`); `process_steps`: Zusammenarbeit & Ablauf (`format_list_numbered`) |
| Kontakt & Anfragen (`contact_mail`) | `contact_submissions`: Eingegangene Anfragen (`inbox`); `contact_channels`: Kontaktwege (`alternate_email`) |

Die Gruppen sind virtuelle Folder-Collections mit `schema: null`, keine neuen
Inhaltstabellen. Das Skript setzt ausschließlich Icons, Navigationsgruppen,
Reihenfolgen sowie Anzeigenamen für `de-DE` und `en-US`. Andere Übersetzungen
und vorhandene Singular-/Pluralangaben bleiben erhalten. Die deutschen Namen
werden auch bei englischer Studio-Sprache angezeigt.

Neue Gruppen starten aufgeklappt. Bestehende Sichtbarkeit, Singleton-Einstellungen,
Sortierfelder für Inhalte, Notizen und andere Metadaten bleiben erhalten.
Bestehende Gruppen behalten Aufklappzustand, Farbe und Sichtbarkeit. Rechte
werden nicht erweitert; Kontaktanfragen bleiben durch die bisherigen Policies
geschützt. Normale Seiten und Rechtstexte liegen weiterhin gemeinsam in `pages`.

## Reguläres Setup und Deployment

`setup.mjs` wendet die Navigation nach dem vorhandenen Schema-/Rechte-Setup an.
Installer, Compose-Mounts und Deployment-Skript berücksichtigen das zusätzliche
Modul. Bei manuellen Releases deshalb beide `.mjs`-Dateien übertragen; beim
Ausführen der kopierten `/tmp/lucky-setup.mjs` muss das Modul unter
`/tmp/setup-collection-navigation.mjs` liegen.

Der root-eigene Einstiegspunkt `/usr/local/sbin/deploy-luckydice-backend` muss
mit der neuen Version von `deploy/deploy.sh` aktualisiert werden, bevor dieser
Release per Actions deployt wird (siehe `deploy/README.md`). Sonst fehlen beim
Setup die neue Datei und ihr Import. Der Workflow ersetzt den Einstiegspunkt
bewusst nicht selbst aus einem Upload.

## Bestehende VPS-Installation nur umgruppieren

Für die reine Navigation ist es nicht erforderlich, das komplette `setup.mjs`
erneut auszuführen. Das vermeidet dessen sonstige Schema-, Rechte- und
Inhaltsanpassungen.

Die neue Datei nach
`/opt/luckydicedesign/backend/setup-collection-navigation.mjs` übertragen. Ein
manuell übertragenes Exemplar lässt sich beispielsweise so installieren:

```bash
sudo install -m 0644 -o root -g root \
  /home/timo/cms-navigation-upload/setup-collection-navigation.mjs \
  /opt/luckydicedesign/backend/setup-collection-navigation.mjs
```

Vorher über den bisherigen Backup-Prozess PostgreSQL und Uploads sichern. Dann
im laufenden Container zuerst die Vorschau ausführen:

```bash
cd /opt/luckydicedesign/backend
sudo docker compose cp setup-collection-navigation.mjs luckydice-cms:/tmp/setup-collection-navigation.mjs
sudo docker compose exec -u root luckydice-cms chmod 0644 /tmp/setup-collection-navigation.mjs
sudo docker compose exec luckydice-cms node /tmp/setup-collection-navigation.mjs --dry-run
```

Das Skript fragt den aktuellen Admin-Login interaktiv ab. Das Passwort erscheint
nicht in der Ausgabe. Danach anwenden:

```bash
sudo docker compose exec luckydice-cms node /tmp/setup-collection-navigation.mjs
```

Optional kann `--env-auth` die bereits vorhandenen Container-Variablen
`ADMIN_EMAIL` und `ADMIN_PASSWORD` verwenden, sofern sie noch gültig sind.
Keine Passwörter als Kommandozeilenargument übergeben oder in GitHub eintragen.

Anschließend das Data Studio neu laden und bei Bedarf auch ein eingeschränktes
Redaktionskonto prüfen. Website-Build und Container-Neustart sind dafür nicht
nötig. Wiederholte Ausführung ist möglich; bereits passende Werte werden
übersprungen. Fehlende Inhaltsmodule werden gemeldet, leere Gruppen nicht
angelegt. Eine Datentabelle unter einem reservierten `nav_*`-Gruppennamen stoppt
das Skript vor den ersten Änderungen. Bei einem API-Fehler sind eventuell schon
einzelne Metadatenänderungen angewendet; der nächste Lauf setzt den Vorgang fort.

## Prüfen

```bash
node --test setup-collection-navigation.test.mjs
```

Die Tests prüfen Metadatenerhalt, wiederholte Ausführung, Vorschau ohne
Schreibzugriffe, Namenskonflikte und die vollständige Zuordnung aller Schema-
Collections. Sie laufen auch im Backend-Workflow.

Directus beschreibt diese reinen Navigationsordner in der
[Collection-Dokumentation](https://docs.directus.io/app/data-model/collections)
und `schema: null` in der
[Collections-API](https://docs.directus.io/reference/system/collections).
