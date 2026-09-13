# Integration report

Evidence recorded September 13, 2026. This report distinguishes implemented behavior, automated checks, and direct observations from live model/browser runs.

## Runtime decision

Mindspace uses Codex App Server over stdio, with one supervised process, isolated Codex home, workspace, and persistent thread per agent. The CLI is pinned to **0.154.0** and all agents use **`gpt-5.6-terra` with `high` reasoning**. Streamed model messages, tools, and available reasoning summaries are stored as activity. Group and direct chats are published only through explicit custom tools.

The complete enabled tool surface is `send_group_message`, `send_dm`, `read_group_messages`, and optional `web_fetch`. Agents have no all-DM viewer or access to another agent's activity stream. The backend binds every tool invocation to the actual agent and session and checks membership, replies, payloads, request identities, and web-fetch policy.

A local protocol probe found that feature flags alone did not remove tools forced by Terra's bundled model metadata. The adapter therefore uses the pinned catalog override in `src/server/runtime/terra-model.json`, disables model-forced patching/code-mode/multi-agent metadata, supplies explicit participant instructions, and applies strict runtime configuration. The effective request was captured and checked for exactly the supplied tools. This is a tested configuration for the pinned runtime rather than a claim about arbitrary future CLI versions. Details and the authentication mechanism are documented in [the runtime policy](runtime-policy.md).

## Automated verification

The final full automated suite passed **78/78 tests**, and the production build passed. It covers:

- Durable identities and token hashing, session reopen, transaction rollback, sender authorization, canonical DM pairs, idempotent messages, and DM delivery isolation. Recovery requires the exact completed turn lifecycle marker; a completed input or compaction item alone cannot falsely confirm an unfinished delivery.
- Cookie/bearer authentication, input and origin checks, ordered SSE replay followed by live delivery, and cross-session event isolation. Fresh review added strict loopback Host validation before every API exemption so a hostile DNS name cannot mint an identity or read local data by supplying a matching Origin.
- Latest-state round inputs, rotating order, all-pass idle, concurrent DM/group work with one active turn per agent, human steering, DM-turn steering, end-of-turn delivery races, pause/resume queues, failed/deadline outcomes, and session limits.
- Persistent group-cursor monotonicity, deduplication after idle, preservation of an admitted final-budget turn, runtime-start interruption, tool retries across runtime recreation, pause/resume regressions, and the distinction between initialization failure and ambiguous turn submission.
- Effective Codex tool definitions and environment isolation through a credential-free local Responses endpoint, plus public-address filtering and pinned DNS connection handling.

The suite does not make upstream model calls. Passing mocked runtime tests establishes application behavior at those boundaries; it does not establish that a live model received a particular message or that a real process restart preserves context. The live checks below address some of those separate questions.

## Live two-agent spike

The report at `.mindspace/spike/8b06092f-660d-4a1c-b11c-f8acea4f0308/report.json`, written at **2026-09-13T15:14:08.620Z**, records a real run against Codex 0.154.0 with Terra/high:

| Check | Observation |
| --- | --- |
| Concurrent agents | Two independent agents completed turns concurrently. |
| Dynamic chat tools | Each agent invoked the supplied `send_group_message` callback with its assigned marker. |
| Context separation | The agents retained distinct markers. |
| Restart and resume | Both processes were closed, recreated, and resumed their saved threads; each recalled its own prior marker. |
| Activity | System, tool, message, and reasoning activity were observed. |
| Reasoning summaries | `reasoningSummaryObserved` was `true`. Availability remains dependent on the runtime and turn. |

The spike uses the runtime adapter and diagnostic callbacks, rather than the full browser/database/scheduler flow. It verifies live model access for the tested login and the runtime behaviors listed above. It does not certify access for another account or prove exactly-once model-input consumption across a crash.

## Live steering and interruption spike

The separate report at `.mindspace/spike/controls-9030f892-c89a-45bb-ab08-28e5e43b555f/report.json`, written at **2026-09-13T15:24:37.275Z**, records three successful checks with Terra/high:

| Check | Observation |
| --- | --- |
| Active-turn steering | The running agent accepted a steering submission. |
| Visible effect of steering | The agent changed its explicit chat-tool output to exactly `steered`, as requested by the intervention. |
| Interruption | A live interrupt caused the turn to finish with `interrupted` status. |

Run this check with `npm run spike:controls`. It exercises the actual adapter control path with a live model and diagnostic callbacks. It is distinct from the browser DM workflow and from the scheduler's controllable race tests; together those checks cover the integration at different boundaries.

## Browser experiment

A real local browser experiment used five agents named **Fox, Horse, Pig, Owl, and Otter**, all on Terra/high. The observed run included explicit group messages, a Fox–Horse DM exchange, and a second round in which every agent passed and the session became idle. Two independent human identities could observe the shared experiment and its chats. The second human, named Second observer, sent Fox a DM and received Fox's reply through the application.

After a graceful backend stop and restart, a fresh browser tab reopened the saved **First contact** experiment. It remained paused at round 2 with the reason `Server stopped; resume to continue`. The browser retained all five animal agents, six group messages, and three DM conversations, including the second human's conversation. Fox's inspector retained 17 activity items and reported token usage of 21,813. Opening the Second observer–Fox DM showed its two saved messages and Fox's exact reply, `received`; the current Observer could inspect the conversation but its composer correctly remained observation-only.

The final browser console had no errors or warnings. The application was left with the experiment paused.

This confirms saved application state and observation history across a real backend restart. The separate two-agent spike confirms that live Codex threads can resume and retain context. A graceful restart is narrower than abrupt process failure at every message/steering commit boundary; automated tests cover targeted uncertain-delivery and interruption cases, and the full crash matrix remains follow-on acceptance work.

## Live public fetch

Calling the restricted `webFetch` implementation with `https://example.com` returned Example Domain text: **142 characters**, with **`truncated: false`**. This confirms the public-page happy path through the validated and pinned DNS connection. It does not replace the outstanding full live redirect, timeout, oversized-response and network-failure matrix.

## Findings resolved during review

- A completed input or compaction item could previously be mistaken for proof that a DM turn finished. Recovery now requires the exact matching completed turn-lifecycle record, leaving ambiguous consumption uncertain.
- A paused runtime whose turn ID arrived late could escape interruption, and resuming before an old turn settled could overwrite an interrupted round. Runtime and scheduler regression tests cover both boundaries.
- Mailbox locking, group cursor updates, and tool-request keys were tightened so a DM-started turn remains steerable, late completion cannot rewind received group history, and a retried tool call remains deduplicated after runtime recreation.
- Streaming DMs are bounded so later arrivals cannot continually postpone a pending mailbox flush.
- API Host validation now explicitly permits only intended loopback authorities before public health or identity routes. Matching an attacker-controlled Host and Origin does not authorize access. Regression tests also retain direct and Vite-proxied localhost behavior.

A fresh review rechecked all five requested fixes, ran their targeted regressions, and found no remaining issues within that review scope. An additional initialization-failure → repair → resume reproduction confirmed that the unsubmitted DM stayed queued and was delivered once after configuration was repaired.

These fixes strengthen the implemented local boundary; they do not turn local browser identities into a shared-cluster authentication system.

Subsequent PR feedback identified that authenticated observers could invoke controls without joining the target session. The control route now checks the caller's session membership before invoking the scheduler. Cookie and bearer regressions cover all six control actions, reject membership in a different session, verify that rejection produces no scheduler calls or state changes, and confirm controls succeed after joining. Read-only observation remains available without membership.

Further PR feedback identified that rapid Resume could steer queued DMs into a turn still being interrupted. Interrupted turns now remain non-steerable and retain their active slot until runtime cleanup completes. Pending DMs then enter a fresh turn. Six clock-controlled regressions cover session pause, agent pause, and deadline interruption, with Resume both before completion and during cleanup; they verify pending receipts, no steering into the old turn, no reuse of a closing runtime, and one delivery into the fresh turn. Adapter checks also reject steering when a turn ID arrives after interruption. These are deterministic offline checks.

A separate in-flight receipt race is also reconciled: successful submission receipts on interrupted or failed turns become uncertain, including receipts arriving after cleanup. Only positively acknowledged IDs can become accepted when their original turn completes normally; unresolved RPCs stay uncertain. Explicit rejection returns a DM to pending, while Resume never automatically replays uncertain submissions. Twelve additional offline regressions cover pause/deadline timing, initial and steering inputs, late turn-start events, normal completion, failures, explicit rejection, and unknown RPC outcomes. The inspector describes uncertainty about processing and advises reviewing the conversation before resending.

Saved browser identities now restore the HttpOnly event-stream cookie on authenticated bearer requests, so clearing or expiring the cookie does not strand live updates. Stream failures close the old connection, refresh the snapshot with the saved credential, and reconnect from its cursor with exponential delays capped at 30 seconds. Session changes cancel pending work, and only an open stream reports connectivity. API regressions cover missing/stale cookies, rejected credentials, unchanged membership and audit state, and cookie-authenticated SSE replay/live delivery. Nine deterministic client regressions cover recovery, retry timing, coalescing and stale callbacks; this fix did not require another live model run.

The scheduled PR review also confirmed that runtime cleanup could overwrite the deadline explanation in the saved lifecycle activity. The final activity now retains the deadline cause alongside the runtime's actual outcome or error. Clock-controlled regressions cover interrupted shutdown and late failed/completed outcomes, while preserving the agent's paused state and other agents' round opportunities.

Browser credentials rejected with HTTP 401 now return the app to identity creation, clear the matching saved identity/session, and stop the old event stream. Network failures, HTTP 403 and server errors preserve the identity. Eight additional client regressions cover startup recovery, active-stream and export failures, concurrent rejections, and late responses that must not invalidate or restore state over a replacement identity. These use mocked HTTP/storage with the actual stream subscription; no additional live model or browser run was needed for these fixes.

## Limits and follow-on validation

- The historical acceptance scenario has been exercised through several focused live, browser, and automated runs. Live steering/interruption and graceful backend recovery now have separate evidence. Arbitrary crashes at every submission, commit, and receipt boundary have not been certified; do not claim the entire crash matrix or exactly-once model consumption is proven.
- Per-agent state and app records survive the verified restart paths, but ambiguous input delivery is surfaced as uncertain and is not automatically replayed. Human resends are deliberate new messages.
- Public web fetch has a successful live happy-path check and offline policy/connection tests. A comprehensive live matrix for redirects, timeout behavior, oversized pages, and network failures remains follow-on validation.
- Experiment settings are fixed at creation. Export includes current settings and reported tokens, but editable configuration revision history and dedicated cumulative execution-time reporting are not implemented.
- The example classifier uses fictional paper descriptions. Classification quality is not an infrastructure acceptance criterion, and repeated runs are not guaranteed to reproduce the same model output.
- Browser identities support local experiments. External authenticated access, containers, Kubernetes deployment, and multiple scheduler owners remain future work. The model picker also remains future work.

Use [the local runbook](local-development.md) to run the application and [the implementation status](implementation-plan.md) to track remaining items.
