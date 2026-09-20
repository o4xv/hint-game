<div align="center">
  <img src="client/public/assets/logo.png" alt="Hint — هنت" width="140">
  <h1>Hint · هنت</h1>
  <p>An Arabic multiplayer party game about clues, guesses, and thinking alike.</p>
  <p><a href="https://hint-delta.vercel.app"><img src="docs/images/play-hint.svg" alt="Play Hint — open the game" width="240" height="64"></a></p>
  <p><a href="#run-locally">Run locally</a> · <a href="docs/TESTING.md">Testing</a></p>
</div>

## How it works

A card gives you two ends of a spectrum, such as **cold ↔ hot**.
One player—the clue giver—sees a secret target and gives a clue.
Everyone else guesses where that clue belongs by moving a needle.

For example, **“hot tea”** suggests a position toward the hot end.
Reveal the target: the closer the guess, the more points it earns.

<table>
  <tr>
    <td align="center"><img src="docs/images/clue.png" alt="The clue giver sees a secret target on the dial" width="240"></td>
    <td align="center"><img src="docs/images/guess.png" alt="A player moves the needle using the clue, with the target hidden" width="240"></td>
    <td align="center"><img src="docs/images/reveal.png" alt="The round reveal shows guesses and their scores" width="240"></td>
  </tr>
  <tr>
    <td align="center"><strong>1. Give a clue</strong></td>
    <td align="center"><strong>2. Make a guess</strong></td>
    <td align="center"><strong>3. Reveal the target</strong></td>
  </tr>
</table>

_Screenshots from a local demo with fictional players. The game interface is in Arabic._

## Features

- **Play with friends:** rooms for up to 12 players, individual or team mode.
- **Team turns:** custom team names and a designated player who controls the needle.
- **Learn by playing:** an interactive walkthrough and practice rounds.
- **Made for phones:** Arabic right-to-left layout, touch controls, and an installable PWA.
- **Stay in the game:** reconnect to your seat, watch as a spectator, and vote for a rematch.
- **155 cards** across three packs, with one free card change before giving a clue.

Multiplayer needs a connection. After an online visit, the cached app also supports offline practice.

## Built with

**React · TypeScript · Vite · Node.js · Express · Socket.IO · Playwright**

The server owns room state, scoring, timers, and private targets. The browser renders the game
and sends player actions through shared typed contracts. Tests cover game rules, reconnection,
mobile interactions, and browser journeys in Chromium and WebKit.

## Run locally

Requires **Node.js 24** and **npm 11**. Download or clone this repository, then run these commands from its root. No account, API key, or database is needed for local play.

```sh
npm run install:all
npm run dev
```

Open **http://localhost:5173**. Use another browser or a private window to join as a second player.

For phone testing, environment variables, and checks, see the [setup guide](docs/SETUP.md).
Rooms use memory by default and reset when the server restarts; Redis persistence is optional.

## Explore the project

| Folder             | Responsibility                                          |
| ------------------ | ------------------------------------------------------- |
| [client/](client/) | Game UI, session recovery, and PWA                      |
| [server/](server/) | Multiplayer rooms, rules, scoring, and timers           |
| [shared/](shared/) | Event contracts, validation schemas, and shared scoring |
| [e2e/](e2e/)       | Browser and multiplayer tests                           |

See the [setup guide](docs/SETUP.md) and [testing guide](docs/TESTING.md).
