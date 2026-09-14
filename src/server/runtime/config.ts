import { access, chmod, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimentDirectory } from '../experiment-files.js';

/** The bundled catalog also forces tools, independently of feature flags. */
export const TERRA_CATALOG = fileURLToPath(new URL('./terra-model.json', import.meta.url));

export const RUNTIME_CONFIG: Record<string, unknown> = {
  model: 'gpt-5.6-terra',
  model_reasoning_effort: 'high',
  model_reasoning_summary: 'auto',
  model_catalog_json: TERRA_CATALOG,
  approval_policy: 'never',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  include_environment_context: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  check_for_update_on_startup: false,
  cli_auth_credentials_store: 'file',
  mcp_servers: {},
  apps: { _default: { enabled: false } },
  skills: { bundled: { enabled: false }, include_instructions: false },
  tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
  shell_environment_policy: { inherit: 'none' },
  features: {
    shell_tool: false, unified_exec: false, shell_snapshot: false,
    view_image: false, sleep_tool: false, apps: false,
    plugins: false, remote_plugin: false, recommended_plugins: false,
    tool_suggest: false, multi_agent: false, multi_agent_v2: false,
    browser_use: false, browser_use_external: false, computer_use: false,
    in_app_browser: false, image_generation: false, goals: false,
    code_mode: false, code_mode_host: false, skill_search: false,
    skill_mcp_dependency_install: false, hooks: false, workspace_dependencies: false,
    memories: false, request_permissions_tool: false,
    skip_host_skill_discovery: true,
  },
};

function toml(value: unknown): string {
  if (value === null || value === undefined) throw new Error('Null is not a TOML configuration value');
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Mindspace runtime directory must be a real directory');
  await chmod(path, 0o700);
}

export async function prepareRuntime(
  agentId: string,
  dataDir: string,
  { probeBaseUrl, sessionId }: { probeBaseUrl?: string; sessionId?: string } = {},
): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error('Invalid runtime agent identifier');
  const runtimeRoot = resolve(dataDir, 'runtime', agentId);
  const runtimeHome = join(runtimeRoot, 'codex-home');
  const cwd = sessionId ? experimentDirectory(dataDir, sessionId) : join(runtimeRoot, 'workspace');
  await privateDirectory(dirname(runtimeRoot));
  await privateDirectory(runtimeRoot);
  await privateDirectory(runtimeHome);
  await privateDirectory(cwd);

  const config = { ...RUNTIME_CONFIG };
  if (probeBaseUrl) {
    const url = new URL(probeBaseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Protocol probes must use a credential-free loopback HTTP endpoint');
    }
    config.model_provider = 'mindspace_probe';
    config.model_providers = {
      mindspace_probe: {
        name: 'Mindspace local protocol probe', base_url: url.toString(),
        wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
      },
    };
    config.cli_auth_credentials_store = 'ephemeral';
  } else {
    // Codex owns credential parsing and refresh. Never load tokens into the application.
    const sourceAuth = resolve(process.env.MINDSPACE_AUTH_FILE || join(homedir(), '.codex', 'auth.json'));
    const runtimeAuth = join(runtimeHome, 'auth.json');
    let existing;
    try { existing = await lstat(runtimeAuth); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) {
      if (await readlink(runtimeAuth) !== sourceAuth) throw new Error('Unexpected runtime authentication link');
    } else if (existing && !existing.isFile()) {
      throw new Error('Invalid runtime authentication file');
    } else if (!existing) {
      try { await access(sourceAuth); } catch {
        throw new Error('Codex login is required. Run `codex login` locally, then retry.');
      }
      await symlink(sourceAuth, runtimeAuth);
    }
  }

  // Do not propagate API keys, service-account tokens, MCP credentials, or host settings.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/bin:/bin',
    HOME: homedir(),
    CODEX_HOME: runtimeHome,
    TMPDIR: process.env.TMPDIR || '/tmp',
  };
  const args = ['--stdio', '--strict-config'];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${toml(value)}`);
  return { args, env, cwd };
}
