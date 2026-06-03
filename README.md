# MinecraftBroadcaster

Standalone Minecraft Bedrock / Xbox Broadcaster built with **Node.js + TypeScript**.

This project creates and maintains Xbox Live / Minecraft sessions, synchronizes friends, and redirects players through NetherNet/WebRTC to your actual Bedrock or Geyser server.

## Features

* Microsoft/Xbox Device Code Authentication using `prismarine-auth`
* Xbox Session Directory Updates
* RTA/WebSocket Reconnect Logic
* NetherNet / WebRTC Signaling
* Bedrock Server Ping for MOTD, Player Count and Protocol Version
* Friend Synchronization with Auto Follow / Auto Unfollow
* Optional Discord Webhook Notifications
* Local Logs and Cache Files
* TypeScript Build System powered by `esbuild`

## Requirements

* Node.js **20 or newer**
* npm
* A reachable Minecraft Bedrock or Geyser server
* A Microsoft/Xbox account for broadcasting

## Installation

```bash
npm install
```

## Configuration

Copy the example configuration:

```bash
cp config.example.yml config.yml
```

Then update at least the following values inside `config.yml`:

```yml
bedrockVersion: "1.26.20"

session:
  sessionInfo:
    hostName: "My Server"
    worldName: "Lobby"
    ip: "127.0.0.1"
    port: 19132
```

Important: `config.yml`, `cache/`, and `logs/` are excluded from Git because they may contain local data, tokens, or secrets.

## Running

Development mode:

```bash
npm start
```

Create a production build:

```bash
npm run build
```

Run the compiled build:

```bash
npm run start:js
```

## Login

On first startup, the application will ask you to authenticate using Microsoft's Device Code flow.

Follow the link displayed in the console and enter the provided code.

If authentication fails:

1. Stop the application
2. Delete `cache/auth.json` or the entire `cache/` directory
3. Optionally change the following settings in `config.yml`:

```yml
auth:
  deviceProfile: android
  microsoftAuthFlow: sisu
```

Then start the application again.

## NPM Scripts

| Script              | Description                      |
| ------------------- | -------------------------------- |
| `npm start`         | Starts `src/main.ts` using `tsx` |
| `npm run build`     | Creates `dist/main.js`           |
| `npm run start:js`  | Runs the compiled build          |
| `npm run typecheck` | Runs TypeScript type checking    |

## Project Structure

```txt
src/
  app/        Main application / standalone runner
  auth/       Microsoft / Xbox authentication
  config/     YAML configuration
  core/       Logger, constants and paths
  network/    RTA, NetherNet, WebRTC and signaling
  services/   Ping, Discord, Xbox profiles and notifications
  session/    Xbox session payload and controller
  social/     Friends list and synchronization
  storage/    Cache, sessions and SQLite history
```

## Security

Never upload:

* `config.yml`
* `.env` files
* `cache/`
* `logs/`
* `auth.json`
* Databases such as `player_history.db`

These files may contain tokens, account information or private server data.

## License

This project is licensed under the **GPL-3.0 License**. See the `LICENSE` file for details.
