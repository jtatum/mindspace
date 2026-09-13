import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export const CODEX_VERSION = '0.154.0';
export type WireMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string; code?: number } };

/** Stdio transport only. No model data or credentials are written to stdout. */
export class CodexRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private stderr = '';

  constructor(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    super();
    this.child = spawn(process.env.MINDSPACE_CODEX_BIN || 'codex', ['app-server', ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: WireMessage;
      try { message = JSON.parse(line); } catch { this.emit('warning', 'Ignoring non-JSON runtime output'); return; }
      if (message.method) { this.emit('notification', message); return; }
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex process exited (${code ?? signal}). ${this.stderr.slice(-1200)}`)));
    this.child.stdin.on('error', error => this.fail(error));
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  send(message: WireMessage) {
    if (this.closed) throw new Error('Codex runtime connection is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex runtime connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'mindspace', title: 'Mindspace', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} }); return result;
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await new Promise<void>(resolve => { if (this.child.exitCode !== null) resolve(); else this.child.once('exit', () => resolve()); });
    clearTimeout(timer);
  }
}
