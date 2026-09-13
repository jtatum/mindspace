# Mindspace implementation plan

Status: local application implemented, September 13, 2026. Current evidence is recorded in [the integration report](integration-report.md); startup and recovery instructions are in [the local runbook](local-development.md). Behavior is specified in [the architecture](architecture.md).

Every current agent uses **GPT-5.6 Terra (`gpt-5.6-terra`) with `high` reasoning effort**. Five agents and two independent human identities have exercised the local application. Model choice remains fixed until the later picker milestone.

The original work items and completion criteria below remain useful acceptance targets. The following status table distinguishes implemented work from partial criteria; a working local application does not imply every historical criterion is complete.

## Current implementation status

The production build passed. The final automated run passed **98/98 tests**, including storage/API integration, controllable scheduler/runtime tests, a credential-free Codex tool-policy probe, and review regressions.

| Items | Status | Evidence or remaining detail |
| --- | --- | --- |
| MS-01 | Implemented with a narrower protocol layer | TypeScript workspace, pinned version checks, stdio transport and real handshakes are present. Full generated App Server bindings are not checked into the project. |
| MS-02–03 | Verified live | Terra/high completed concurrent real turns; two distinct marker contexts survived process restart and thread resume. |
| MS-04 | Verified by protocol probe and live callbacks | The outgoing model request exposes exactly the supplied Mindspace tools. Model-forced tools required a version-specific catalog override; see the runtime policy. |
| MS-05 | Core runtime behavior verified live | Concurrency, tools, progress and reasoning summaries were observed. A separate controls spike confirmed active steering, changed explicit chat output and live interruption. Application races have reusable regression coverage. |
| MS-06–11 | Implemented and tested | React/Vite, Fastify, SQLite, local human identities, three-to-five-agent setup, durable chats, sender checks, transactional deduplication, SSE replay, and the group/DM browser workspace. |
| MS-12–18 | Implemented | Durable runtime/thread mapping, custom tools, mailboxes, activity storage, per-agent inspectors and human DM composers are connected. Controllable fake runtimes exist in tests; no simulation-mode launcher is shipped. Live browser checks observed agent DMs and a second human's DM receiving a reply. |
| MS-19–23 | Implemented and tested | Rotating sequential rounds, latest-state inputs, DM concurrency, all-pass idle, cooldown, session/agent pause, deadlines and budgets. Fake-clock tests cover steering, bounded mailbox flushing and pause/resume races; live controls passed and the five-agent browser run reached idle after two rounds. |
| MS-24 | Implemented; public happy path verified | Optional bounded public fetch, private-address rejection and pinned DNS are present. A real fetch of `https://example.com` returned 142 characters of Example Domain text without truncation. Offline checks cover URL/address policy and connection lookup; the complete live redirect/size/timeout failure matrix remains follow-on verification. |
| MS-25 | Implemented; graceful restart verified | Store tests, the live two-agent context-resume spike, and a real backend restart all pass. A fresh browser retained the five-agent experiment paused at round 2 with saved chats, Fox's 17 activity items and reported usage, including the second human's DM and Fox's exact `received` reply. Arbitrary crash-boundary acceptance remains broader than this evidence. |
| MS-26 | Partial | Per-agent reported tokens and JSON experiment export are implemented. Editable configuration revision history and dedicated cumulative execution-time reporting are not. Settings are fixed when an experiment is created. |
| MS-27 | MVP example available | The creation dialog can insert a fixed fictional paper-classification exercise. A separate expanded corpus of paper titles/abstracts is not packaged. |
| MS-28 | Local MVP exercised; full crash matrix remains | Five live agents, agent DMs, explicit group messages, two human observers, a human DM reply, all-pass idle and the local runbook are verified. Separate live controls and backend-restart checks passed. Complete the remaining arbitrary-crash and comprehensive browser acceptance matrix before claiming every original criterion is proven. |
| MS-29–30 | Planned | Runtime-backed model and reasoning selection, validation and configuration-change history. |
| MS-31–32 | Planned packaging/deployment | Graceful local shutdown and configurable state paths are present. A container, cluster authentication, persistent volumes, Kubernetes manifests and cluster recovery validation are not implemented. |

Fresh review also added strict loopback Host validation before every API exemption, tightened recovery to require an exact completed turn marker, and covered delayed interruption, pause/resume races, retry keys, monotonic cursors and bounded DM flushing. The next acceptance work is the broader crash/fetch/browser matrix, followed by the chosen model-selection or deployment milestone. Current persistence supports continued experiments; it does not promise deterministic model replay or exactly-once consumption across arbitrary crashes.

## Delivery sequence

| Milestone | Outcome |
| --- | --- |
| 0. Codex feasibility | Demonstrate isolated persistent agents, restricted tools, streaming, and steering with the requested model. |
| 1. Durable chat foundation | Humans can use group chat and DMs, and observe the same saved state across browsers. |
| 2. Agent communication | Real agents exchange explicit messages while activity remains separately inspectable. |
| 3. Rounds and intervention | Three agents collaborate through rounds and immediate DMs, with human steering and pause controls. |
| 4. Reliable local MVP | Five agents and two humans can run, reconnect, recover, and inspect an experiment. |
| 5. Follow-on features | Model picker and Kubernetes packaging. |

## Milestone 0: validate the Codex boundary

The initial schema inspection established the relevant interfaces. The implementation now has protocol and live evidence summarized above; the original criteria below identify remaining details without substituting schema support for observed behavior.

| ID | Work item | Depends on | Done when |
| --- | --- | --- | --- |
| MS-01 | Create a minimal TypeScript integration workspace and generate bindings from a pinned CLI. | — | One command performs the stdio handshake and shuts down cleanly; installed and expected versions are checked. |
| MS-02 | Configure isolated runtime state and validate the requested model. | MS-01 | The runtime catalog admits `gpt-5.6-terra` with `high`; a short turn succeeds and neither model nor effort silently falls back. Document the chosen auth mechanism without storing credentials in the repo. |
| MS-03 | Exercise two persistent agent contexts. | MS-02 | Two agents remember different markers across turns and process restarts; each retains its own identity and input history. |
| MS-04 | Prove custom tools and the restricted tool surface. | MS-02 | A harmless custom tool returns through the real callback path; unavailable built-ins and cross-agent storage/API access are blocked by runtime enforcement. Record any unavoidable exposed tool. |
| MS-05 | Exercise streaming, steering, interruption, and concurrent agents. | MS-03, MS-04 | A live trace captures tool lifecycle and whatever reasoning summaries are actually emitted; a DM during work is accepted or queued without loss; two agents run without mixed events. Capture reusable protocol fixtures. |

**Gate result:** the [integration report](integration-report.md) and [runtime policy](runtime-policy.md) record the configuration, observed tool restriction, live context-resume result, and limitations. The model-catalog tool issue was resolved in the adapter before the live collaboration run. Keep this gate when changing the CLI, catalog, or adapter boundaries.

## Milestone 1: durable chat foundation

| ID | Work item | Depends on | Done when |
| --- | --- | --- | --- |
| MS-06 | Add the frontend/backend development layout and shared contracts. | MS-01 | A local command starts the UI and backend; shared message, event, and participant types compile. |
| MS-07 | Add SQLite migrations and storage boundaries. | MS-06 | Session, participant, agent configuration, conversation, message, delivery, round, activity, and event records survive a restart; model and effort are explicit fields. |
| MS-08 | Implement sessions, human identities, and agent roster configuration. | MS-07 | A human creates a task with three to five named agents and instruction text; another browser joins with a distinct identity. |
| MS-09 | Implement durable group and DM messaging. | MS-08 | Commands validate sender membership and DM pairs, save delivery records transactionally, and deduplicate retried requests. All session humans can list every conversation. |
| MS-10 | Add the event stream and reconnect protocol. | MS-09 | Two browsers receive ordered committed events; disconnect/reconnect and snapshot races produce no missing or duplicate visible messages. |
| MS-11 | Build the group/DM workspace. | MS-10 | Humans switch conversations and send as themselves; DM participants and all-human visibility are clear, including when observing an agent pair. |

**Demo:** two human browsers share a persistent session with group chat and DMs before agents are attached.

## Milestone 2: agent communication and observation

| ID | Work item | Depends on | Done when |
| --- | --- | --- | --- |
| MS-12 | Turn the spike into a runtime adapter and scripted fake runtime. | MS-05, MS-07 | Start, resume, run, steer, interrupt, tool callback, and normalized event operations have a stable interface; unknown events remain diagnosable. |
| MS-13 | Add per-agent supervision and context preparation. | MS-08, MS-12 | Each agent has a stable runtime/thread mapping, its own instructions and authorized inputs, and at most one active turn. Changing UI tabs has no runtime effect. |
| MS-14 | Add the persistent DM mailbox and delivery receipts. | MS-09, MS-13 | Idle agents wake, busy agents receive steering, completion races are reconciled, and queued inputs keep sender provenance. No other agent receives an unrelated DM. |
| MS-15 | Implement agent chat tools against the message service. | MS-04, MS-09, MS-14 | Agent-to-agent and agent-to-human DMs and group posts appear once in chat; group-history reads are bounded; no DM-view tool exists. |
| MS-16 | Persist and normalize agent activity. | MS-10, MS-12 | Streamed progress, available summaries, tool inputs/results, errors, and completion states map to the correct agent/turn/item; final text does not automatically publish to chat. |
| MS-17 | Build agent tabs and the inspector. | MS-11, MS-16 | Expand/collapse tool and summary blocks, inspect completed history, and see live status without disturbing the selected group conversation. |
| MS-18 | Add DM steering from an inspector. | MS-14, MS-17 | A human's inspector message creates their DM with that agent; an in-flight agent receives it through the same delivery path as a peer DM. |

**Demo:** a human asks agent A to consult B. Their DM exchange and explicit group result appear in chat, while each tool invocation remains visible in its agent tab.

## Milestone 3: rounds and human control

| ID | Work item | Depends on | Done when |
| --- | --- | --- | --- |
| MS-19 | Implement the round state machine with a controllable clock. | MS-07, MS-13 | Every roster member receives one recorded opportunity; order rotates, later turns receive the latest group sequence, and failed or busy agents have explicit outcomes. |
| MS-20 | Integrate round opportunities with the DM mailbox. | MS-14, MS-15, MS-19 | Peer DMs can run concurrently with another agent's slot, group posts are allowed outside slots, and a busy agent's pending opportunity never overlaps its active turn or disappears. |
| MS-21 | Add cooldown and automatic idle behavior. | MS-20 | A configured countdown starts the next round; an all-pass quiet round sleeps; a message racing with sleep wakes work; ordinary group posts do not trigger an immediate broadcast response storm. |
| MS-22 | Add pause, resume, interrupt, deadlines, and session limits. | MS-20 | Pausing cancels timers and interrupts work, new messages queue, resume processes them, and stuck turns/DM loops reach recorded limits. |
| MS-23 | Build round status and controls. | MS-17, MS-21, MS-22 | Humans see order, passes, active opportunities, failures, countdown, and why a session paused; Run next round and agent/session controls work from either browser. |

**Demo:** three Terra/high agents complete several rounds, exchange DMs between slots, receive human steering, and eventually become idle when everyone passes.

## Milestone 4: reliable local MVP

| ID | Work item | Depends on | Done when |
| --- | --- | --- | --- |
| MS-24 | Add optional bounded web fetch. | MS-04, MS-15 | A permitted agent can retrieve a public page with visible source metadata; a disabled agent cannot; redirects, private destinations, excessive output, and timeout cases are handled. |
| MS-25 | Implement runtime crash reconciliation and restart recovery. | MS-14, MS-16, MS-22 | Restart restores chat and context mappings, reconciles receipts, flags uncertain turns, avoids blindly repeating sends, and brings the session back paused. |
| MS-26 | Add usage, configuration history, and experiment export. | MS-16, MS-23 | Humans can inspect per-agent reported tokens and elapsed time and export messages, round outcomes, available activity, and configuration revisions. Missing usage is shown as unavailable. |
| MS-27 | Add a reusable experiment fixture. | MS-23, MS-24 | A small fixed set of paper titles/abstracts and a classification prompt can seed a session; no arXiv-specific logic is required by the runtime or scheduler. |
| MS-28 | Complete the five-agent/two-human acceptance run and local runbook. | MS-18, MS-25, MS-26, MS-27 | The scenario below passes, documented startup works from a fresh checkout, and startup errors identify missing runtime/model/auth requirements. |

The sample corpus should be fixed for repeatable observation. Live fetching can be demonstrated separately; paper classification correctness is not an infrastructure acceptance criterion.

## Milestone 5: follow-on work

| ID | Work item | Depends on | Done when |
| --- | --- | --- | --- |
| MS-29 | Expose the runtime model catalog and configuration validation. | MS-12, MS-26 | The backend returns available models and supported efforts, validates selections, and records changes between turns. |
| MS-30 | Add per-agent model and reasoning pickers. | MS-29 | Choices come from the runtime catalog, unsupported combinations cannot be submitted, and changing a model preserves agent context with a visible configuration-change event. |
| MS-31 | Build the container and graceful lifecycle. | MS-28 | The pinned runtime starts under supervision, configuration and state paths are externalized, health checks work, and shutdown leaves recoverable session state. |
| MS-32 | Add Kubernetes manifests and verify cluster recovery. | MS-31 | One scheduler replica runs behind authenticated access; persistent volumes and credential delivery are configured; a controlled pod replacement restores the experiment without overlapping owners. |

## MVP acceptance scenario

1. Create one session with five agents, all using `gpt-5.6-terra` with `high`, and join from two human browser profiles.
2. Give the group a task. Observe every agent receiving a round opportunity with its own persistent context.
3. Have agents exchange DMs, publish group messages, and pass. Verify that every human sees these conversations and that an unrelated agent does not receive the DMs or gain a tool for inspecting them.
4. Open an agent inspector during a tool call. Expand its results and available reasoning summaries; verify that activity text stays separate from explicit chat messages.
5. Steer a busy agent from each human identity. Verify sender attribution, receipt/queue status, and continuation without concurrent turns on that agent.
6. Observe the cooldown, a quiet all-pass round going idle, and a new message restarting work. Pause during a pending DM and confirm it waits for Resume.
7. Refresh and reconnect a browser; restart an agent process and the backend; verify restored history, preserved context, visible uncertain/interrupted states, and no duplicated chat side effects.
8. Hit a configured session limit and confirm the whole session pauses, including DM-triggered activity. Export the observation record.

## Verification approach

Use focused scheduler tests with a fake clock for fairness, pass/idle transitions, deadlines, and DM/round races. Use storage/API integration tests for sender authorization, transaction boundaries, retries, and reconnect cursors. Use captured protocol fixtures for adapter parsing and explicit bounded live runs for Codex behavior that fixtures cannot establish. Use browser tests for the two-human workflow and inspector steering.

Crash tests should target specific boundaries: after message commit but before tool response, after a steering submission but before its receipt is saved, and after a final item but before the browser sees it. Each test verifies recovery of observable behavior rather than assuming model execution is replayable.

Run relevant checks with each change and the complete acceptance scenario at MS-28. Planning-only changes require a consistency and link check, not application tests.
