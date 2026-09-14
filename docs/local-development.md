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
3. Choose each agent's public web-fetch permission and the delay between rounds. New experiments have no turn deadline or round, turn, token, or elapsed-time cap. Positive limits remain supported for older API clients; zero disables a limit.
4. Rename an experiment using the pencil beside its title or beside any saved experiment in the sidebar; the change appears in the sidebar and other open views. Start the initially paused experiment. Agents read the latest group state in sequential opportunities. The first speaker rotates between rounds; an all-pass quiet round rests until new work arrives.
5. Open an agent's tab to inspect progress, tool arguments/results, and available reasoning summaries. Send a message from the inspector to steer that agent through your own DM conversation.
6. Open any DM pair to observe its discussion. Every human can inspect every chat; a human can send only as themselves, and cannot post as a participant in an agent-to-agent DM.
7. Pause the entire experiment or an individual agent when needed. Pause requests interruption of active model turns, cancels upcoming rounds, and rejects new agent tool calls. A file write or download already in progress may finish; completed work is not rolled back. Resume continues with saved context and pending work, starting a new turn rather than continuing the interrupted generation. Messages sent while paused remain saved and wait for resume. Export the experiment from the toolbar to save its observation record as JSON.

One active turn is permitted per agent. DMs can wake an idle agent or steer its current turn while another agent has the group opportunity. Ordinary model responses remain in activity; only explicit chat-tool calls publish messages.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `MINDSPACE_PAPERS_BASE_URL` | Unset | Hosted corpus directory containing `manifest.csv` and `papers/0001.pdf` through `papers/2000.pdf`. |
| `MINDSPACE_DATA_DIR` | `.mindspace`, relative to the working directory | SQLite and persistent per-agent Codex runtime state. |
| `MINDSPACE_CODEX_BIN` | `codex` | Executable used for version checks and App Server processes. |
| `MINDSPACE_AUTH_FILE` | `~/.codex/auth.json` | Existing Codex login file used by agent runtime homes. |
| `PORT` | `3001` | Backend HTTP port; binding stays `127.0.0.1`. |

The dev server, `npm start`, and `papers:download` load an optional `.env` in the project root; exported environment variables take precedence. Copy `.env.example` to `.env` to configure a paper host, then restart the server. This is a backend setting.

The Vite development proxy currently targets port 3001. Keep that backend port when using `npm run dev`; using a different `PORT` requires updating the proxy in `vite.config.ts`. The built application can use a different backend port without a proxy.

The browser health check verifies the installed CLI version and the presence of the login file. It does not establish that a login is still valid or that its account can use Terra/high. Agent startup performs the runtime model check and the actual turn confirms access; failures are visible in activity and pause the experiment. Mindspace does not silently substitute another model.

The application links the existing login file into private agent runtime homes without parsing or printing credential values. Codex owns authentication and refresh. See [the runtime policy](runtime-policy.md#authentication) and [Codex authentication documentation](https://learn.chatgpt.com/docs/auth). Authentication and runtime state must stay out of source control; `.mindspace/` is already ignored. No 1Password access is required by the application.

## Persistence and recovery

The data directory contains `mindspace.sqlite` and its SQLite sidecar files, plus `runtime/<agent-id>/` directories containing each agent's Codex home and workspace. Keep the database and all runtime directories together when preserving an experiment; the database alone does not contain the model's persistent context. Stop the server before taking a filesystem backup. Authentication links or files in runtime homes require the same care as the original Codex login.

On restart, saved experiments return paused, unfinished activity and rounds are marked interrupted, and ambiguous accepted deliveries become uncertain. The inspector reports messages with unconfirmed delivery. These uncertain messages are not automatically replayed: inspect the conversation and deliberately send a new message if the agent should receive the instruction again. A confirmed tool send remains in chat and is deduplicated by its request identity.

If the database is reset or restored without your saved browser identity, the app asks for your display name again when the server rejects the old credential. Temporary connection and server failures keep your saved identity intact.

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

## AI paper preset and shared files

The New experiment dialog offers an AI paper review preset alongside Freeform. It collects 2,000 distinct arXiv papers matching “artificial intelligence,” sorted by newest announcement, and starts three identical reviewers with fixed assignments of 667, 667 and 666 papers. When `MINDSPACE_PAPERS_BASE_URL` is set, the preset loads the fixed 2,000-paper `manifest.csv` from that directory. It checks numbering, original arXiv URLs, and PDF/text paths; an unavailable or invalid manifest fails the import instead of substituting a different corpus. Without a host, a prepared `.mindspace/corpora/ai-2000.json` fixture is reused when present. Otherwise the importer collects bounded public search pages with pacing; upstream failure creates no partial experiment. The public search path is used because the metadata API returned rate-limit responses during validation.

Every experiment now has a shared working directory at `.mindspace/experiments/<session-id>/shared/`. Agents retain independent Codex homes and contexts but use the same working directory. Scoped file tools allow listing, paged text reads, and writes with revision checks to prevent overwriting unseen peer edits. The UI’s Shared files button shows its absolute path and files. The imported `papers.csv` and `papers.jsonl` are read-only to agents. Reviewers read the extracted paper text with `read_shared_file` and save Markdown reviews with `write_shared_file` at `reviews/NNNN.md`. The file is saved exactly as written and the same transaction updates the paper queue; only the assigned reviewer can change that numbered review. Revision checks protect against stale edits. Other agents can read the reviews and write shared notes or synthesis files. `record_paper_review` remains available, including for unavailable sources. File listings accept a directory path and paging offset, so the full corpus and review collection are accessible.

The paper tools expose bounded pages and enforce review ownership. `cache_paper` saves a PDF under `papers/0001.pdf`, extracts text to `papers/0001.txt`, and records extraction metadata beside it. Existing files are reused. Missing PDFs come from `MINDSPACE_PAPERS_BASE_URL/papers/NNNN.pdf` when configured, with the manifest checked against the saved paper before downloading. Original arXiv URLs remain citations. Downloads are serialized and paced, capped at 500 MB per PDF from the configured host (to accommodate the prepared corpus’s larger files) or 50 MB from arXiv when no host is configured. Cached PDFs and extracted text continue to be reused; the host only needs to supply the manifest and PDFs. Text extraction stops at 300 pages or two million characters and reports truncation. Agents must distinguish sections actually read, missing sources, and extraction limitations. A downloaded PDF can still be useful when text extraction fails.

To prepare the whole corpus before starting agents, keep the experiment paused and run:

```sh
npm run papers:download -- <session-id>
```

The command saves `download-status.json`, retries transient failures with delays, and preserves completed PDFs. Rerunning resumes from existing files. Avoid running multiple bulk workers for the same corpus, or bulk downloading while agents are fetching papers. Serve only the experiment’s `shared/` directory when hosting the files locally; it contains no Codex login material. `.mindspace/` remains ignored by Git. No local hosting server is started automatically.

The initial three reviewers process small batches over many rounds, with no automatic run limits. Humans can pause at any time; an all-pass round rests only when no unpaused reviewer has pending paper assignments. Saving reviews keeps the queue advancing even without a group summary. Paused assignments do not spin new rounds; resuming their reviewer wakes the remaining work. Add agent in the sidebar lets a joined human add up to two specialists with distinct tasks, including during a run; they enter the next round and can inspect the saved reviews and shared files. Existing assignments do not change. Paused experiments remain paused.
