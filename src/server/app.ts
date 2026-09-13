import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { Store, StoreError } from './store.js';
import type { Message, RuntimeHealth, SessionEvent } from '../shared/types.js';

export type ControlAction = 'start' | 'pause' | 'resume' | 'next-round' | 'pause-agent' | 'resume-agent';
export interface SchedulerApi {
  control(sessionId: string, action: ControlAction, agentId?: string): Promise<unknown> | unknown;
  onMessage(message: Message): Promise<unknown> | unknown;
  shutdown(): Promise<unknown> | unknown;
}
interface AppOptions {
  store: Store;
  scheduler: SchedulerApi;
  health: RuntimeHealth | (() => RuntimeHealth | Promise<RuntimeHealth>);
  webRoot?: string;
}
const identitySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const createSchema = z.object({
  title: z.string().trim().min(1).max(160), task: z.string().trim().min(1).max(40000),
  agents: z.array(z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().max(16000), webFetch: z.boolean().optional() }).strict()).min(3).max(5),
  settings: z.object({
    roundDelayMs: z.number().int().min(0).max(3600000).optional(),
    turnTimeoutMs: z.number().int().min(50).max(1800000).optional(),
    maxRounds: z.number().int().min(1).max(10000).optional(),
    maxTurns: z.number().int().min(1).max(100000).optional(),
    maxTokens: z.number().int().min(1).max(100000000).optional(),
    maxDurationMs: z.number().int().min(100).max(604800000).optional(),
  }).strict().optional(),
}).strict();
const messageSchema = z.object({
  body: z.string().trim().min(1).max(40000), requestId: z.string().min(1).max(200),
  conversationId: z.string().uuid().optional(), recipientId: z.string().uuid().optional(), replyTo: z.string().uuid().optional(),
}).strict();
const controlSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'next-round', 'pause-agent', 'resume-agent']),
  agentId: z.string().uuid().optional(),
}).strict().refine(value => !value.action.endsWith('-agent') || Boolean(value.agentId), 'Agent controls require agentId');

export async function buildApp({ store, scheduler, health, webRoot }: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  const identities = new WeakMap<FastifyRequest, { id: string; name: string }>();
  const streams = new Set<FastifyReply['raw']>();
  const getHealth = async () => typeof health === 'function' ? await health() : health;
  const sessionId = (request: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(request.params).id;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') });
    const status = error instanceof StoreError ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status < 500 ? (error as Error).message : 'The request could not be completed' });
  });

  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    // Loopback binding alone does not stop a hostile DNS name from resolving here.
    // Check the request authority before public routes or browser identity creation.
    const host = request.headers.host ?? '';
    const authority = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
    if (!authority || (authority[2] !== undefined && (Number(authority[2]) < 1 || Number(authority[2]) > 65535))) {
      return reply.code(403).send({ error: 'Mindspace API requests must use a loopback host' });
    }
    // Cookies authorize EventSource requests. Reject browser commands from other sites.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          const url = new URL(origin);
          const target = new URL(`${request.protocol}://${host}`);
          const loopback = (hostname: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
          allowed = url.origin === target.origin || (loopback(url.hostname) && loopback(target.hostname) && url.protocol === 'http:' && ['5173', '5174'].includes(url.port));
        } catch { /* malformed origins are never trusted */ }
        if (!allowed) return reply.code(403).send({ error: 'Cross-origin commands are not allowed' });
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-site commands are not allowed' });
    }
    if (path === '/api/health' || (path === '/api/identities' && request.method === 'POST')) return;
    const authorization = request.headers.authorization;
    let token: string | undefined;
    if (authorization) {
      token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1];
    } else {
      token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('mindspace_token='))?.slice('mindspace_token='.length);
    }
    const identity = token ? store.authenticate(token) : null;
    if (!identity) return reply.code(401).send({ error: 'Create or restore your browser identity first' });
    identities.set(request, identity);
  });

  app.get('/api/health', async () => getHealth());
  app.post('/api/identities', async (request, reply) => {
    const identity = store.createIdentity(identitySchema.parse(request.body).name);
    reply.header('Set-Cookie', `mindspace_token=${identity.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${request.protocol === 'https' ? '; Secure' : ''}`);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(identity);
  });
  app.get('/api/sessions', async () => store.listSessions());
  app.post('/api/sessions', async (request, reply) => {
    const snapshot = store.createSession(createSchema.parse(request.body), identities.get(request)!, (await getHealth()).mode);
    return reply.code(201).send(snapshot);
  });
  app.post('/api/sessions/:id/join', async request => store.joinSession(sessionId(request), identities.get(request)!));
  app.get('/api/sessions/:id', async request => store.snapshot(sessionId(request)));
  app.post('/api/sessions/:id/messages', async (request, reply) => {
    const message = store.sendMessage(sessionId(request), identities.get(request)!.id, messageSchema.parse(request.body));
    await scheduler.onMessage(message);
    return reply.code(201).send(message);
  });
  app.post('/api/sessions/:id/control', async request => {
    const id = sessionId(request);
    store.getSession(id);
    const { action, agentId } = controlSchema.parse(request.body);
    if (agentId && store.getParticipant(id, agentId).kind !== 'agent') throw new StoreError('Agent controls require an agent participant');
    await scheduler.control(id, action, agentId);
    return store.snapshot(id);
  });
  app.get('/api/sessions/:id/export', async (request, reply) => {
    const id = sessionId(request);
    reply.header('Content-Disposition', `attachment; filename="mindspace-${id}.json"`);
    reply.header('Cache-Control', 'no-store');
    return store.snapshot(id);
  });
  app.get('/api/sessions/:id/events', async (request, reply) => {
    const id = sessionId(request);
    store.getSession(id);
    const query = z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).parse(request.query);
    const lastEvent = request.headers['last-event-id'];
    const resumed = typeof lastEvent === 'string' && /^\d+$/.test(lastEvent) ? Number(lastEvent) : 0;
    let cursor = Math.max(query.after ?? 0, Number.isSafeInteger(resumed) ? resumed : 0);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(': connected\n\n');
    streams.add(reply.raw);
    const send = (event: SessionEvent) => {
      if (event.sessionId !== id || event.sequence <= cursor || reply.raw.destroyed) return;
      cursor = event.sequence;
      reply.raw.write(`id: ${event.sequence}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
      // Bound a stalled browser's output queue rather than accumulating indefinitely.
      if (reply.raw.writableLength > 2 * 1024 * 1024) reply.raw.destroy();
    };
    store.on('event', send);
    for (const event of store.eventsAfter(id, cursor)) send(event);
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    reply.raw.on('close', () => { clearInterval(heartbeat); store.off('event', send); streams.delete(reply.raw); });
  });
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Route not found' }) : reply.sendFile('index.html'));
  }
  return app;
}
