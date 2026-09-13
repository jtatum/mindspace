# Codex runtime policy

Mindspace pins `codex-cli 0.154.0` and `gpt-5.6-terra` with `high` reasoning. Each agent gets a separate App Server process, Codex home, workspace, and persistent Codex thread. The browser talks to the Mindspace backend; it cannot send arbitrary App Server requests.

## Why disabling feature flags was insufficient

A credential-free local Responses probe on 2026-09-13 found that Terra's bundled model metadata independently enables `apply_patch`, code mode, and the collaboration namespace. Setting `features.shell_tool`, `features.multi_agent`, `features.multi_agent_v2`, `features.code_mode`, and `features.code_mode_host` to false alone did **not** remove those tools.

`src/server/runtime/terra-model.json` therefore preserves the requested model and its model metadata while setting:

```json
{
  "apply_patch_tool_type": null,
  "tool_mode": null,
  "multi_agent_version": null
}
```

The original instruction templates are removed. Mindspace supplies its participant instructions through `thread/start.baseInstructions`. The catalog is loaded using `-c model_catalog_json="/absolute/path/to/terra-model.json"`. This is a version-specific policy: re-run the protocol test and live validation before changing the CLI or catalog. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents startup catalog overrides.

## Effective configuration

`prepareRuntime` in `src/server/runtime/config.ts` owns the complete configuration. It starts `codex app-server --stdio --strict-config` with explicit overrides, including:

```toml
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
model_reasoning_summary = "auto"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
project_doc_max_bytes = 0
include_environment_context = false
include_apps_instructions = false
include_collaboration_mode_instructions = false

[skills]
bundled = { enabled = false }
include_instructions = false

[tools]
update_plan = { enabled = false }
experimental_request_user_input = { enabled = false }

[shell_environment_policy]
inherit = "none"
```

The code also disables shell and terminal tools, host skill discovery, apps, plugins, tool suggestions, browser and computer use, image generation, built-in agents, goals, hooks, memories, permission requests, and workspace dependency tooling. Isolated homes have no inherited MCP configuration. The process environment contains only `PATH`, the actual user's `HOME`, the isolated `CODEX_HOME`, and `TMPDIR`.

The supplied dynamic tools are `send_group_message`, `send_dm`, and `read_group_messages`; agents with web access additionally receive `web_fetch`. No tool reads DMs or another agent's activity. Incoming DMs are delivered by Mindspace. Dynamic tool calls arrive through the [App Server tool-call protocol](https://learn.chatgpt.com/docs/app-server) and are validated by the backend before execution.

## Authentication

Live runtime homes link `auth.json` to the existing local Codex login file, normally `~/.codex/auth.json`; an explicit `MINDSPACE_AUTH_FILE` can select another login file. Agent runtime directories use mode `0700`. The application does not parse, log, or copy token values. Codex owns authentication and refresh.

If Codex atomically rewrites `auth.json` during refresh, it may replace the link with a private runtime credential file. Existing regular credential files are retained. Concurrent logout/login or refresh behavior across multiple linked runtime homes has not been proven by the policy probe; authentication errors must remain visible and require restoring valid Codex login. Do not put runtime state in source control or export it with experiments. The [official authentication guide](https://learn.chatgpt.com/docs/auth) describes credential stores and treats `auth.json` as a secret.

The installed schema marks `chatgptAuthTokens` as an internal-only unstable interface, so this integration does not use it.

## Verification

Run:

```sh
node --import tsx --test tests/runtime-policy.test.ts
```

The integration test starts the installed Codex binary against a local fake Responses endpoint, with ephemeral authentication and no login file. It inspects the outgoing model request, including tool definitions in `input[type=additional_tools]`, and asserts:

- The requested model remains `gpt-5.6-terra` and reasoning remains `high`.
- The complete exposed tool set equals the four supplied Mindspace tools.
- No authorization header, host skill instructions, global agent instructions, or built-in agent instructions leak into the request.
- The runtime home is private and the environment does not inherit credentials.

All three policy tests passed on 2026-09-13 with Codex 0.154.0. They make no upstream model request. A live spike separately verifies model access, tool execution, streaming, steering, and restart persistence; the policy test does not establish those behaviors.
