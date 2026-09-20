# Local development

## Quick start

Install Node.js 24 and npm 11. From the repository root:

```sh
npm run install:all
npm run dev
```

Open http://localhost:5173. The backend listens on port 3001.
Use separate browser profiles or a private window for different players; tabs in the same
profile may restore the same identity.

Defaults require no external service or credentials. Rooms live in memory and are lost on
server restart.

## Environment variables

Vite loads client environment files. For custom values, copy `client/.env.example` to
`client/.env.local`:

```env
VITE_SERVER_URL=http://localhost:3001
VITE_SENTRY_DSN=
```

Variables prefixed with `VITE_` are public build-time configuration. Never place a server
secret in them.

The server reads process environment variables. `server/.env.example` lists supported values;
the development command does **not** automatically load a server or root `.env` file.
Set custom values in the terminal or hosting environment.

To explicitly load a file with the compiled server, create `server/.env` from its example, then
run from the root:

```sh
npm run build
node --env-file=server/.env server/dist/index.js
```

| Server variable               | Default / purpose                                         |
| ----------------------------- | --------------------------------------------------------- |
| `PORT`                        | `3001`                                                    |
| `ALLOWED_ORIGINS`             | `http://localhost:5173`; comma-separated frontend origins |
| `REDIS_URL`                   | Empty; optional persistent room storage                   |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Optional server analytics                                 |
| `SENTRY_DSN`                  | Optional server error reporting                           |
| `ROOM_CREATION_LIMIT`         | `30` room creations per network address per minute        |

Keep environment files out of Git.

## Phone testing

Connect both devices to the same Wi-Fi network. Find the computer's local IP
(e.g. `192.168.1.100`) and set `client/.env.local`:

```env
VITE_SERVER_URL=http://192.168.1.100:3001
```

Allow both frontend origins when starting development.

PowerShell:

```powershell
$env:ALLOWED_ORIGINS = "http://localhost:5173,http://192.168.1.100:5173"
npm run dev
```

macOS / Linux:

```sh
ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.100:5173 npm run dev
```

Open `http://192.168.1.100:5173` on the phone. Vite already listens on all interfaces.
Your firewall must permit local access to ports 5173 and 3001.

LAN HTTP is useful for gameplay checks but does not reproduce installed-PWA behavior.
Use HTTPS to check installation, offline reopening, keyboard layout, and safe areas on a physical phone.

See [Testing](TESTING.md) for checks.
