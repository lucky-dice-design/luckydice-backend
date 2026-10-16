# GitHub Actions → VPS

`/.github/workflows/deploy.yml` prüft jeden Push und Pull Request. Nur nach
bestandenen Prüfungen auf `main` wird deployt; ein Merge löst den normalen
Push-Workflow aus. `workflow_dispatch` erlaubt einen erneuten Lauf auf diesem
Branch. Ein überholter Commit wird vor dem Upload übersprungen. Deployments
brechen laufende Deployments nicht ab. Eine gemeinsame VPS-Dateisperre
serialisiert außerdem alle vier Repositories.

## GitHub einmalig konfigurieren

In `lucky-dice-design/luckydice-backend` die Umgebung **production** anlegen und ihre
Deployment-Branches auf `main` beschränken. Dort folgende Werte eintragen;
alternativ Organisations-Secrets/Variablen gezielt für alle vier Repositories
freigeben:

| Typ | Name | Wert |
| --- | --- | --- |
| Variable | `VPS_HOST` | `212.227.161.13` |
| Variable | `VPS_USER` | `timo` (vorhandener Wartungszugang) |
| Variable | `VPS_PORT` | `22` |
| Secret | `VPS_SSH_KEY` | Privater SSH-Schlüssel des Wartungszugangs, für unbeaufsichtigte Anmeldung geeignet |
| Secret | `VPS_KNOWN_HOSTS` | Verifizierter SSH-Hostkey-Eintrag für den VPS |

Keine Schlüssel in Git oder Chat einfügen. Den Hostkey über den bestehenden,
bereits verifizierten Zugang bzw. die IONOS-Konsole vergleichen; `ssh-keyscan`
allein bestätigt die Identität nicht. GitHub Actions verwendet strikte
Hostkey-Prüfung. Ein verschlüsselter privater Schlüssel funktioniert ohne
zusätzliches Entsperren nicht mit diesem Workflow. Einen bestehenden privaten
Schlüssel nicht dafür entschlüsselt überschreiben.

## VPS einmalig vorbereiten

Voraussetzungen: bestehende funktionsfähige Docker-Installation, Docker Compose,
Python >= 3.12, `rsync`, `curl`, `flock`, `timeout`, `tar`, `gzip`, `cron` und
`logrotate`. Beide Directus-Instanzen müssen über den Docker-Caddy erreichbar
sein. `.env`, SMTP-Zugang, CMS-Tokens, Datenbanken und Uploads bleiben auf dem VPS.
Die Workflows richten keine neue CMS-Instanz ein.

Der zusätzliche systemweite Caddy muss gestoppt und deaktiviert bleiben:

```bash
sudo systemctl disable --now caddy.service
```

Alle vier geprüften `deploy/deploy.sh`-Dateien über den vorhandenen SSH-Zugang
in getrennte Upload-Ordner kopieren. Je Repository installiert der Administrator
den zugehörigen Einstiegspunkt. Beispiel für **dieses** Repository (Uploadpfad
entsprechend anpassen):

```bash
sudo install -o root -g root -m 0750 \
  /home/timo/deploy-setup/luckydice-backend/deploy/deploy.sh \
  /usr/local/sbin/deploy-luckydice-backend
```

Diese Einstiegspunkte bleiben root-eigen. Änderungen an `deploy/deploy.sh`
müssen nach Prüfung erneut installiert werden; der Workflow ersetzt sie nicht
selbst aus einem Upload.

Einmal `/etc/lucky-deploy.conf` root-eigen mit Modus `0600` anlegen:

```bash
DEPLOY_HOME=/home/timo
```

Den Eintrag **dieses** Repositories mit `sudo visudo -f
/etc/sudoers.d/github-deploy-luckydice-backend` anlegen:

```sudoers
timo ALL=(root) NOPASSWD: /usr/local/sbin/deploy-luckydice-backend *
```

Der Einstiegspunkt akzeptiert nur einen vollständigen Git-Commit-SHA. Das ist
ein privilegierter Deployment-Zugang: freigegebener Anwendungscode kann auf dem
VPS ausgeführt werden. Schreib-/Merge-Rechte und die GitHub-Umgebung daher nur
den bisherigen vertrauenswürdigen Administratoren geben. Die vier Jobs brauchen
keinen direkten Docker-Zugang und keine allgemeinen neuen sudo-Rechte.

**Gemeinsamen Caddy vor dem ersten Backend-Deployment übernehmen:** Im
hochgeladenen, geprüften Himmelsteil-Backend-Quellbaum ausführen:

```bash
sudo bash /home/timo/deploy-setup/himmelsteil_backend/deploy/prepare-caddy.sh
```

Dieses Skript vergleicht die aktuell im Container verwendete Caddy-Konfiguration
mit dem geplanten Aufbau anhand der adaptierten JSON-Konfiguration, ohne sie
anzuzeigen oder Dienste neu zu laden. Bei Abweichungen stoppt es. Zusätzliche,
root-geprüfte Blöcke können vorher in `/etc/lucky-deploy/caddy-extra.conf`
hinterlegt werden. Nicht blind ganze Domainblöcke doppelt übernehmen.

Nach erfolgreicher Übernahme liegen dort die Himmelsteil-Basis, zusätzliche
Blöcke und gegebenenfalls die Markierung `himmelsteil-production-enabled`.
Lucky-Dice-Blöcke werden aus dem installierten Backend eingebunden. Eine bisher
inaktive Himmelsteil-Hauptdomain wird durch Deployments nicht aktiviert.

## Was das Deployment aktualisiert

- Konfiguration, PostgreSQL und Directus-Uploads sichern; beide Datenarchive prüfen.
- Backend-Dateien aktualisieren, den vorhandenen additiven Schema-/Rechte-Setup ausführen und den Webserver neu erstellen.
- Dieser vorhandene Setup kann außerdem die Firmen-E-Mail aus den Seed-Daten übernehmen und den technischen Token aktualisieren. Es ist eine CMS-Änderung, kein reines Kopieren von Dateien.
- Den Lucky-Dice-Block im gemeinsamen Caddy aktualisieren, validieren und Caddy neu laden. Ein fehlgeschlagener Reload stellt die vorige Caddy-Datei wieder her.
- Einen vollständigen CMS-Fallback exportieren und den bestehenden Fünfminuten-Cronjob samt Logrotation aktualisieren.

Alle vier Skripte prüfen abschließend beide CMS über den lokalen Caddy mit
korrektem TLS-Hostnamen. Ein aktiver oder für den Autostart aktivierter Host-Caddy
stoppt das Deployment vor Änderungen. Das prüft das lokale Routing; externe
DNS-/Firewall-Erreichbarkeit muss zusätzlich von außen geprüft werden.

Backend-Deployments lehnen geänderte PostgreSQL-/Directus-Imageangaben ab.
Versionsupgrades benötigen einen geplanten Migrationsschritt. Die Tags bleiben
die bestehenden Tags, ein automatisches `pull` findet nicht statt.

## Fehler und Wiederherstellung

Ein Fehler macht den GitHub-Lauf rot; der Log nennt den fehlgeschlagenen Schritt.
Deployments sind nicht über mehrere Repositories atomar. Für voneinander
abhängige Änderungen zuerst das kompatible Backend deployen, dann das Frontend.
Es gibt keinen automatisch ausgeführten Datenbank-Rollback.

Root-lesbare Konfigurations-/Dateisicherungen liegen unter
`/var/backups/lucky-deploy/<repository>/<UTC-Zeit>-<Commit>/`. Die
Himmelsteil-Datenbank-/Upload-Sicherung liegt wie bisher unter
`/opt/himmelsteil-cms/backups/`. Die Konfigurationssicherungen können Geheimnisse
enthalten und dürfen nicht als GitHub-Artefakt hochgeladen werden.

Bei einem fehlgeschlagenen Backend-Update können Dateien bereits ausgetauscht
sein. Dann anhand des fehlgeschlagenen Schritts den vorigen Konfigurationsstand
prüfen und gezielt wiederherstellen; dabei aktuelle Secrets und Datenbankstand
berücksichtigen. Nach einer Schema-/Rechteänderung reicht ein Code-Rollback
nicht immer aus. Keine Volumes löschen und kein `docker compose down -v`
ausführen. Nach der Wiederherstellung beide `/server/ping`-URLs prüfen.

Erfolgreiche Deployments schreiben `.deployed-revision` neben die jeweiligen
Projektdateien. Uploads und zusätzliche Deployment-Sicherungen werden nicht
automatisch gelöscht; nach bestätigter Funktion nach eigener Aufbewahrungspolitik
bereinigen und VPS-Speicherplatz kontrollieren. Bestehende Datenbackups behalten
ihre bisherige Aufbewahrung.

## Aktivierungsstand

Diese Dateien allein schalten noch nichts auf dem VPS frei. Die Workflows müssen
in GitHub veröffentlicht und die oben genannten Secrets, Variablen, sudo-
Einstiegspunkte sowie der Caddy-Übernahmeschritt eingerichtet sein. Danach einen
manuellen Lauf für den Hauptbranch auslösen und das Ergebnis prüfen. Vor dieser
Einrichtung ist kein erfolgreiches Ende-zu-Ende-Deployment nachgewiesen.
