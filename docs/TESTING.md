# Testing

## Automated checks

After `npm run install:all`, run from the repository root:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Install browser engines before the first end-to-end run:

```sh
cd e2e
npx playwright install chromium webkit
cd ..
npm run test:e2e
```

Linux CI uses `--with-deps` when installing browsers.
This source snapshot includes current-game tests and sanitized historical payload fixtures.
The old-version browser migration suite and manual screenshot-capture scripts remain in the
private development repository; they are not part of this snapshot. No old Git history is required.

| Area           | Coverage                                                            |
| -------------- | ------------------------------------------------------------------- |
| Shared         | Input schemas, event payloads, scoring boundaries                   |
| Server         | Authorization, secret targets, rooms, scoring, timers, persistence  |
| Client         | State, recovery, forms, tutorial, PWA updates                       |
| Browsers       | Individual/team rounds, reconnect, rematch, mobile layout and touch |
| Compatibility  | Historical payload replay and saved snapshots           |
| Production PWA | Updates, cached reopening, offline practice                         |

## Proportional local validation

Run focused tests during development. After building shared contracts and the server, a selected
browser file can run from `e2e/`:

```sh
npx playwright test mobile-layout.spec.js --project=mobile-chromium --project=mobile-webkit
```

For documentation-only changes, inspect rendered Markdown, links, assets, and the diff.
Rerun multiplayer tests only when behavior changes or a relevant failure needs investigation.
GitHub Actions runs quality and full browser checks for submitted commits.

Do not weaken assertions or increase timeouts solely to obtain a green run.
Record results against the exact tested commit.

## Physical-device checks

Desktop WebKit does not prove physical iPhone Safari or installed-PWA behavior.
Some production-PWA cases are explicitly Chromium-only. Inspect skip reasons.
Check keyboard layout, safe areas, background/resume, screen rotation, and offline
reopening on a physical phone before a release.
