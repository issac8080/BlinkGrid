# BlinkGrid server tests

## Commands

```bash
npm test
```

Runs Jest once in Node (`testEnvironment: "node"`). Socket.io integration tests spin up a real in-memory HTTP server on an ephemeral port and connect with `socket.io-client`.

```bash
npm run test:sim
```

Runs only [`game.simulation.test.js`](game.simulation.test.js): phased time-based match simulation (fake timers + in-memory room), plus socket bootstraps and edge cases. `[SIM]` logs are on locally by default; in CI they are off unless `SIM_LOG=1`. Use `SIM_LOG=0` locally to silence.

```bash
npm run test:watch
```

Re-runs tests on file changes during development.

## Layout

| Path | Role |
|------|------|
| `tests/game.test.js` | Main QA suite: initialization, tiles, taps, freeze, bots, concurrency, game end, disconnects |
| `tests/helpers/harness.js` | `startTestServer`, `createTestRoom`, `addTestPlayers`, `setPlayersReady`, `simulateTileClick`, `pollRoomPhase` |
| `tests/helpers/mockRoom.js` | In-memory `io` stub + `createHumanPlayer` / `createBotPlayer` for engine-only tests |
| `lib/blinkGridServer.js` | Shared game logic + Socket.io handlers (used by `server.js` and tests) |

Engine-level helpers are exposed only for tests via `require("../lib/blinkGridServer")._test` (for example `tryProcessTap`, `spawnBlink`, `tickPlayingRoom`). Do not use `_test` from production code.

## Behaviour notes (spec vs implementation)

- **Bots:** For 1–4 humans, the server adds `6 - humans` bots (max six entities total). Five or six humans get **no** bots. Three humans therefore get three bots (not listed in every QA checklist, but covered by the same rule).
- **Mid-game disconnect:** The match ends when **no humans** remain (`humansIn(room).length < 1`). One human left **does not** auto-end the game (differs from a product rule such as “end when fewer than two humans remain”).
- **Deterministic integration tests** call `startPlayingMatch` in `game.test.js`, which stops spawn/tick timers after entering `playing` so random spawns and time-based `game:over` do not interfere with tap concurrency checks.

## Load testing (many real clients)

```bash
npm start
# other terminal:
npm run loadtest
```

See the header comment in [`loadTest.js`](../loadTest.js) for env vars (`TOTAL_CLIENTS`, `SERVER_URL`, `RUN_MS`, etc.). BlinkGrid allows **six humans per room**; the script opens `ceil(N/6)` rooms and randomizes `tileClick` on a 5×5 grid.

## Timers

Unit blocks use `jest.spyOn(Date, "now")` and `jest.useFakeTimers` where needed. Integration blocks use real timers for Socket.io, with short `setTimeout` gaps so `room:ready` is processed before `game:start`.
