# MinecraftBroadcaster

Standalone Minecraft Bedrock / Xbox Broadcaster in **Node.js + TypeScript**.  
Das Projekt erstellt und aktualisiert eine Xbox-/Minecraft-Session, synchronisiert Freunde und leitet Spieler per NetherNet/WebRTC auf deinen echten Bedrock- oder Geyser-Server weiter.

## Features

- Microsoft/Xbox Device-Code-Login über `prismarine-auth`
- Xbox Session Directory Updates
- RTA/WebSocket Reconnect-Logik
- NetherNet / WebRTC Signaling
- Bedrock-Server-Ping für MOTD, Spielerzahl und Protokoll
- Freundes-Sync mit Auto-Follow / Auto-Unfollow
- optionaler Discord-Webhook für Benachrichtigungen
- lokale Logs und Cache-Dateien
- TypeScript-Build über `esbuild`

## Voraussetzungen

- Node.js **20 oder neuer**
- npm
- ein erreichbarer Minecraft Bedrock- oder Geyser-Server
- ein Microsoft-/Xbox-Konto für den Broadcaster

## Installation

```bash
npm install
```

## Konfiguration

Kopiere die Beispielkonfiguration:

```bash
cp config.example.yml config.yml
```

Passe danach mindestens diese Werte in `config.yml` an:

```yml
bedrockVersion: "1.26.20"

session:
  sessionInfo:
    hostName: "Mein Server"
    worldName: "Lobby"
    ip: "127.0.0.1"
    port: 19132
```

Wichtig: `config.yml`, `cache/` und `logs/` werden nicht ins Git-Repository übernommen, weil dort lokale Daten, Tokens oder Secrets liegen können.

## Starten

Entwicklungsmodus mit TypeScript direkt:

```bash
npm start
```

Produktionsbuild erstellen:

```bash
npm run build
```

Build starten:

```bash
npm run start:js
```

## Login

Beim ersten Start fordert das Programm dich zur Microsoft Device-Code-Anmeldung auf. Folge dem Link in der Konsole und gib den angezeigten Code ein.

Wenn der Login fehlschlägt:

1. Prozess stoppen
2. `cache/auth.json` löschen oder den kompletten `cache/`-Ordner entfernen
3. in `config.yml` testweise ändern:

```yml
auth:
  deviceProfile: android
  microsoftAuthFlow: sisu
```

Danach erneut starten.

## NPM-Scripts

| Script | Beschreibung |
| --- | --- |
| `npm start` | Startet `src/main.ts` mit `tsx` |
| `npm run build` | Erstellt `dist/main.js` |
| `npm run start:js` | Startet den gebauten Build |
| `npm run typecheck` | Prüft TypeScript ohne Build-Ausgabe |

## Ordnerstruktur

```txt
src/
  app/        Haupt-App / Standalone-Runner
  auth/       Microsoft-/Xbox-Auth
  config/     YAML-Konfiguration
  core/       Logger, Konstanten, Pfade
  network/    RTA, NetherNet, WebRTC, Signaling
  services/   Ping, Discord, Xbox-Profil, Notifications
  session/    Xbox-Session Payload / Controller
  social/     Freundesliste / Friend-Sync
  storage/    Cache, Sessions, SQLite-History
```

## GitHub Release bauen

```bash
npm install
npm run typecheck
npm run build
```

Danach kannst du das Repository committen und auf GitHub pushen:

```bash
git init
git add .
git commit -m "chore: prepare project for GitHub release"
git branch -M main
git remote add origin https://github.com/DEINNAME/MinecraftBroadcaster.git
git push -u origin main
```

## Sicherheit

Nicht hochladen:

- `config.yml`
- `.env` Dateien
- `cache/`
- `logs/`
- `auth.json`
- Datenbanken wie `player_history.db`

Diese Dateien können Tokens, Accountdaten oder private Serverdaten enthalten.

## Lizenz

Dieses Projekt ist unter der **GPL-3.0** lizenziert. Siehe [`LICENSE`](LICENSE).
