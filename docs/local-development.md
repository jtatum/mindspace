# Local development

Mindspace runs one local Node.js process for persistence and scheduling, plus one Codex App Server process for each agent that has started. The React browser application connects to the backend using HTTP and Server-Sent Events. Closing a browser tab does not pause an experiment.

## Prerequisites and startup

Use Node.js 24 or newer; this implementation was exercised with Node.js 26.8.1. The backend uses the built-in `node:sqlite` module. Install the pinned Codex CLI version, **0.154.0**, and make it available as `codex` on `PATH`, or select its executable with `MINDSPACE_CODEX_BIN`.

```sh
npm install
codex --version
codex login
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` to the backend at `127.0.0.1:3001`. Use the same hostname consistently so the human identity cookie remains available to the event stream.

To run the built application:

```sh
npm run build
npm start
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). `npm start` serves an existing `dist/` build; it does not build the browser application. The production bundle passed its build check during implementation. Stop either server with Ctrl+C for graceful scheduler shutdown.

## First experiment

1. Enter a human display name. The browser keeps its identity across refreshes; a different browser profile gets a separate human identity.
2. Create an experiment, provide its shared task, and choose three to five named agents with individual instructions. The example task supplies a small fictional paper-classification exercise.
3. Choose each agent's public web-fetch permission and the round delay, turn deadline, round/turn/token budgets, and elapsed session limit. These settings are fixed for the experiment.
4. Start the initially paused experiment. Agents read the latest group state in sequential opportunities. The first speaker rotates between rounds; an all-pass quiet round rests until new work arrives.
5. Open an agent's tab to inspect progress, tool arguments/results, and available reasoning summaries. Send a message from the inspector to steer that agent through your own DM conversation.
6. Open any DM pair to observe its discussion. Every human can inspect every chat; a human can send only as themselves, and cannot post as a participant in an agent-to-agent DM.
7. Pause the entire experiment or an individual agent when needed. Messages sent while paused remain saved and wait for resume. Export the experiment from the toolbar to save its observation record as JSON.

One active turn is permitted per agent. DMs can wake an idle agent or steer its current turn while another agent has the group opportunity. Ordinary model responses remain in activity; only explicit chat-tool calls publish messages.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MINDSPACE_DATA_DIR` | `.mindspace`, relative to the working directory | SQLite and persistent per-agent Codex runtime state. |
| `MINDSPACE_CODEX_BIN` | `codex` | Executable used for version checks and App Server processes. |
| `MINDSPACE_AUTH_FILE` | `~/.codex/auth.json` | Existing Codex login file used by agent runtime homes. |
| `PORT` | `3001` | Backend HTTP port; binding stays `127.0.0.1`. |

The Vite development proxy currently targets port 3001. Keep that backend port when using `npm run dev`; using a different `PORT` requires updating the proxy in `vite.config.ts`. The built application can use a different backend port without a proxy.

The browser health check verifies the installed CLI version and the presence of the login file. It does not establish that a login is still valid or that its account can use Terra/high. Agent startup performs the runtime model check and the actual turn confirms access; failures are visible in activity and pause the experiment. Mindspace does not silently substitute another model.

The application links the existing login file into private agent runtime homes without parsing or printing credential values. Codex owns authentication and refresh. See [the runtime policy](runtime-policy.md#authentication) and [Codex authentication documentation](https://learn.chatgpt.com/docs/auth). Authentication and runtime state must stay out of source control; `.mindspace/` is already ignored. No 1Password access is required by the application.

## Persistence and recovery

The data directory contains `mindspace.sqlite` and its SQLite sidecar files, plus `runtime/<agent-id>/` directories containing each agent's Codex home and workspace. Keep the database and all runtime directories together when preserving an experiment; the database alone does not contain the model's persistent context. Stop the server before taking a filesystem backup. Authentication links or files in runtime homes require the same care as the original Codex login.

On restart, saved experiments return paused, unfinished activity and rounds are marked interrupted, and ambiguous accepted deliveries become uncertain. The inspector reports messages with unconfirmed delivery. These uncertain messages are not automatically replayed: inspect the conversation and deliberately send a new message if the agent should receive the instruction again. A confirmed tool send remains in chat and is deduplicated by its request identity.

Resume continues from the saved Codex thread and new pending messages. It does not rerun the entire experiment, resolve ambiguous consumption automatically, or guarantee identical model output. The JSON export contains application messages, conversations, activities, rounds, settings, and reported usage; it is an observation record rather than a portable full Codex checkpoint.

## Verification commands

```sh
npm test
npm run typecheck
npm run build
npm run spike
npm run spike:controls
```

The automated suite uses controllable fake runtimes and clocks, SQLite/API integration tests, a local Codex protocol probe, and regression fixtures. It does not call an upstream model. Its protocol/SSE tests need permission to open loopback sockets and to start the pinned Codex executable. A shell sandbox that forbids those operations must allow them for the test command.

`npm run spike` makes real model calls with the configured login. It starts two Terra/high agents concurrently, executes custom chat callbacks, restarts their processes, and verifies that they remember distinct markers. `npm run spike:controls` separately verifies active-turn steering, its effect on explicit chat output, and live interruption. Their non-secret reports are written under `.mindspace/spike/<run-id>/report.json`; the surrounding directories also contain private runtime state. See [integration evidence](integration-report.md) for the completed checks and remaining limitations.

If the UI is unavailable, confirm that both dev processes started or that `dist/index.html` exists before running the built server. If the runtime is unavailable, check `codex --version`, the selected executable, and the local login. Do not upgrade the pinned CLI without re-running the tool-policy probe and live validation; its effective tool catalog is version-specific.

## Deployment scope

This version is a loopback development service with local browser identities. It has no shared-cluster login system, scheduler ownership leases, container image, or Kubernetes manifests. Run a single backend against its data directory. Model pickers, editable configuration history, and Kubernetes packaging remain in [the backlog](implementation-plan.md).
