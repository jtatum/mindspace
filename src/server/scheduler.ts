import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Activity, Message, Participant, Round, Session, SessionEvent, Snapshot } from '../shared/types.js';
import type { AgentRuntime, RuntimeFactory, RuntimeTurnResult } from './runtime/types.js';
import type { Store } from './store.js';
import { webFetch } from './web-fetch.js';
import { cachePaper } from './paper-cache.js';
import { assertSharedWritePath, experimentDirectory, listSharedFiles, readSharedFile, writeSharedFile } from './experiment-files.js';

export interface SchedulerClock { now(): number; setTimeout(fn: () => void, ms: number): any; clearTimeout(timer: any): void }
const clockDefault: SchedulerClock = { now: Date.now, setTimeout, clearTimeout };
type Active = { runtime: AgentRuntime; turnId: string; deadline: any; settled: Promise<RuntimeTurnResult>; sessionId: string; deliveryIds: string[]; inputCursor: number; acceptsSteering: boolean; acknowledgedDeliveryIds: Set<string>; outcome?: RuntimeTurnResult['status'] };
const messageArgs = z.object({ body: z.string().trim().min(1).max(20000), reply_to: z.string().optional() });

export class Scheduler {
  private runtimes = new Map<string, AgentRuntime>();
  private active = new Map<string, Active>();
  private timers = new Map<string, { id: any; at: number }>();
  private advancing = new Set<string>();
  private delivering = new Set<string>();
  private messageSequences = new Map<string, number>();
  private generations = new Map<string, number>();
  private paperGenerations = new Map<string, number>();
  private activityQueue = new Map<string, Activity>();
  private closed = false;
  private eventListener = (event: SessionEvent) => { if (event.type === 'message.created') this.onMessage(event.data as Message); };
  constructor(private store: Store, private factory: RuntimeFactory, private clock: SchedulerClock = clockDefault, private dataDir = process.env.MINDSPACE_DATA_DIR || '.mindspace') {
    for (const session of store.listSessions()) this.messageSequences.set(session.id, Math.max(0, ...store.snapshot(session.id).messages.map(m => m.sequence)));
    store.on('event', this.eventListener);
  }
  private iso() { return new Date(this.clock.now()).toISOString(); }
  private schedule(key: string, fn: () => void, ms: number, preserveEarlier = false) {
    const at = this.clock.now() + Math.max(0, ms);
    if (preserveEarlier && (this.timers.get(key)?.at ?? Infinity) <= at) return;
    this.cancel(key);
    const timer = this.clock.setTimeout(() => { this.timers.delete(key); if (!this.closed) fn(); }, Math.max(0, ms));
    this.timers.set(key, { id: timer, at });
  }
  private cancel(key: string) { const timer = this.timers.get(key); if (timer !== undefined) this.clock.clearTimeout(timer.id); this.timers.delete(key); }
  private scheduleDelivery(sessionId: string, agentId: string, delay = 75) {
    if (this.active.get(agentId)?.acceptsSteering === false) return; // Completion drains the mailbox after cleanup.
    const key = `dm:${agentId}`;
    // Batch arrivals against the first deadline so ongoing chat cannot starve delivery.
    this.schedule(key, () => { void this.deliver(sessionId, agentId); }, delay, true);
  }
  private async interruptAgent(agentId: string) {
    this.paperGenerations.set(agentId, (this.paperGenerations.get(agentId) || 0) + 1);
    const active = this.active.get(agentId);
    if (!active) return;
    active.acceptsSteering = false;
    this.recordAcknowledgedDeliveries(active, [...active.acknowledgedDeliveryIds]);
    this.cancel(`dm:${agentId}`);
    await active.runtime.interrupt();
  }
  private recordAcknowledgedDeliveries(active: Active, ids: string[]) {
    if (!ids.length) return;
    for (const id of ids) active.acknowledgedDeliveryIds.add(id);
    // A receipt confirms submission, but interruption leaves processing unknown.
    const state = active.acceptsSteering || active.outcome === 'completed' ? 'accepted' : 'uncertain';
    this.store.markDeliveries(ids, state, active.turnId);
  }
  private guard(session: Session, admittingTurn = true): string | null {
    if (admittingTurn && session.settings.maxTurns > 0 && session.turnCount >= session.settings.maxTurns) return 'Turn limit reached';
    if (session.settings.maxDurationMs > 0 && session.startedAt && this.clock.now() - Date.parse(session.startedAt) >= session.settings.maxDurationMs) return 'Session time limit reached';
    const tokens = this.store.snapshot(session.id).participants.reduce((sum, p) => sum + (p.tokensUsed || 0), 0);
    if (session.settings.maxTokens > 0 && tokens >= session.settings.maxTokens) return 'Token limit reached';
    return null;
  }
  private hasPendingPapers(agent: Participant): boolean {
    return !!agent.paperReview && this.store.readPapers(agent.sessionId, { reviewerId: agent.id, status: 'pending', limit: 1 }).papers.length > 0;
  }
  async control(sessionId: string, action: string, agentId?: string) {
    const session = this.store.getSession(sessionId);
    if (action === 'pause') { await this.pause(sessionId, 'Paused by a human'); return; }
    if (action === 'pause-agent' || action === 'resume-agent') {
      if (!agentId) throw new Error('Agent ID is required');
      const agent = this.store.getParticipant(sessionId, agentId);
      if (agent.kind !== 'agent') throw new Error('Only agents can be paused');
      const pause = action === 'pause-agent';
      this.store.updateParticipant(sessionId, agentId, { pausedByHuman: pause, status: pause ? 'paused' : 'idle' });
      if (pause) await this.interruptAgent(agentId);
      else if (session.status !== 'paused') {
        if (session.status === 'idle' && this.hasPendingPapers(agent)) this.store.updateSession(sessionId, { status: 'running', reason: null });
        void this.deliver(sessionId, agentId); this.kick(sessionId);
      }
      return;
    }
    if (!['start', 'resume', 'next-round'].includes(action)) throw new Error('Unknown session action');
    if (session.status === 'running') return;
    const reason = this.guard(session);
    if (reason) { await this.pause(sessionId, reason); return; }
    if (session.settings.maxRounds > 0 && session.roundNumber >= session.settings.maxRounds) { await this.pause(sessionId, 'Round limit reached'); return; }
    this.cancel(sessionId);
    this.generations.set(sessionId, (this.generations.get(sessionId) || 0) + 1);
    this.store.updateSession(sessionId, { status: 'running', reason: null, nextRoundAt: null, startedAt: session.startedAt || this.iso() });
    for (const agent of this.store.snapshot(sessionId).participants.filter(p => p.kind === 'agent')) {
      if (!agent.pausedByHuman && !this.active.has(agent.id)) this.store.updateParticipant(sessionId, agent.id, { status: 'idle' });
      void this.deliver(sessionId, agent.id);
    }
    const startTime = Date.parse(this.store.getSession(sessionId).startedAt!);
    if (session.settings.maxDurationMs > 0) this.schedule(`limit:${sessionId}`, () => { void this.pause(sessionId, 'Session time limit reached'); }, startTime + session.settings.maxDurationMs - this.clock.now());
    this.kick(sessionId);
  }
  async pause(sessionId: string, reason: string) {
    this.generations.set(sessionId, (this.generations.get(sessionId) || 0) + 1);
    this.cancel(sessionId); this.cancel(`limit:${sessionId}`);
    this.store.updateSession(sessionId, { status: 'paused', reason, nextRoundAt: null });
    const snapshot = this.store.snapshot(sessionId);
    for (const round of snapshot.rounds.filter(r => r.status === 'running')) {
      round.status = 'interrupted'; round.completedAt = this.iso();
      for (const opportunity of round.opportunities) {
        if (opportunity.status === 'running') { opportunity.status = 'failed'; opportunity.turnId = this.active.get(opportunity.agentId)?.turnId || opportunity.turnId; }
        else if (opportunity.status === 'pending') opportunity.status = 'skipped';
      }
      this.store.saveRound(round);
    }
    await Promise.all(snapshot.participants.filter(p => p.kind === 'agent').map(async agent => {
      this.store.updateParticipant(sessionId, agent.id, { status: 'paused' });
      await this.interruptAgent(agent.id);
    }));
  }
  onMessage(message: Message) {
    if (this.closed) return;
    if (message.sequence <= (this.messageSequences.get(message.sessionId) || 0)) return;
    this.messageSequences.set(message.sessionId, message.sequence);
    const snapshot = this.store.snapshot(message.sessionId);
    const conversation = snapshot.conversations.find(c => c.id === message.conversationId)!;
    if (snapshot.session.status === 'paused') return;
    if (conversation.kind === 'dm') {
      const recipient = snapshot.participants.find(p => p.id !== message.senderId && conversation.participantIds.includes(p.id));
      if (recipient?.kind === 'agent') this.scheduleDelivery(message.sessionId, recipient.id);
    } else if (snapshot.session.status === 'idle') {
      this.store.updateSession(message.sessionId, { status: 'running', reason: null }); this.kick(message.sessionId);
    }
  }
  private kick(sessionId: string) {
    if (this.closed || this.advancing.has(sessionId)) return;
    queueMicrotask(() => { void this.advance(sessionId).catch(error => this.pause(sessionId, `Scheduler error: ${error.message}`)); });
  }
  private input(snapshot: Snapshot, agent: Participant, kind: 'round' | 'dm') {
    const deliveries = this.store.pendingDeliveries(snapshot.session.id, agent.id);
    const deliveredIds = new Set(deliveries.map(d => d.messageId));
    const group = snapshot.conversations.find(c => c.kind === 'group')!;
    const groupMessages = snapshot.messages.filter(m => m.conversationId === group.id && m.sequence > agent.groupCursor);
    const page = groupMessages.slice(0, 100);
    const direct = snapshot.messages.filter(m => deliveredIds.has(m.id));
    const annotate = (m: Message) => ({ id: m.id, sequence: m.sequence, from: snapshot.participants.find(p => p.id === m.senderId)?.name, senderId: m.senderId, senderKind: snapshot.participants.find(p => p.id === m.senderId)?.kind, body: m.body, replyTo: m.replyTo });
    const text = JSON.stringify({ event: kind === 'round' ? 'group_round_opportunity' : 'incoming_direct_messages', task: snapshot.session.task, paperProgress: snapshot.paperProgress, self: { id: agent.id, name: agent.name }, participants: snapshot.participants.map(p => ({ id: p.id, name: p.name, kind: p.kind })), round: snapshot.session.roundNumber, groupMessages: page.map(annotate), groupHasMore: groupMessages.length > page.length, directMessages: direct.map(annotate), guidance: kind === 'round' ? 'Read the latest state, contribute if useful or pass. Use read_group_messages to retrieve any remaining history. Send chat explicitly through tools. End your turn when done.' : 'These messages are addressed to you. Human messages may steer ongoing work; agent messages are peer communications. Reply through tools only if useful. Do not acknowledge acknowledgments.' });
    return { text, deliveryIds: deliveries.map(d => d.id), cursor: page.at(-1)?.sequence ?? agent.groupCursor };
  }
  private getRuntime(agent: Participant) {
    let runtime = this.runtimes.get(agent.id);
    if (!runtime) {
      runtime = this.factory(agent, {
        onThread: threadId => this.store.updateParticipant(agent.sessionId, agent.id, { threadId }),
        onUsage: tokens => {
          this.store.updateParticipant(agent.sessionId, agent.id, { tokensUsed: tokens });
          const reason = this.guard(this.store.getSession(agent.sessionId), false);
          if (reason) void this.pause(agent.sessionId, reason);
        },
        onTurnStarted: turnId => {
          const active = this.active.get(agent.id);
          if (active) {
            active.turnId = turnId;
            this.recordAcknowledgedDeliveries(active, active.deliveryIds);
            const current = this.store.getParticipant(agent.sessionId, agent.id);
            this.store.updateParticipant(agent.sessionId, agent.id, { groupCursor: Math.max(current.groupCursor, active.inputCursor) });
            const round = this.store.snapshot(agent.sessionId).rounds.find(r => r.status === 'running' && r.opportunities.some(o => o.agentId === agent.id && o.status === 'running'));
            const opportunity = round?.opportunities.find(o => o.agentId === agent.id && o.status === 'running');
            if (round && opportunity && opportunity.turnId !== turnId) { opportunity.turnId = turnId; this.store.saveRound(round); }
            this.scheduleDelivery(agent.sessionId, agent.id);
          }
        },
        onActivity: activity => {
          this.recordActivity(activity);
          const latest = this.store.getParticipant(agent.sessionId, agent.id);
          const status = activity.kind === 'tool' && activity.status === 'inProgress' ? 'tool' : 'thinking';
          if (latest.status !== status && this.store.getSession(agent.sessionId).status !== 'paused' && !latest.pausedByHuman) this.store.updateParticipant(agent.sessionId, agent.id, { status });
        },
        onTool: (name, args, callId) => this.tool(agent, name, args, callId),
      }); this.runtimes.set(agent.id, runtime);
    }
    return runtime;
  }
  private recordActivity(activity: Activity) {
    const key = `activity:${activity.id}`;
    if (activity.status !== 'inProgress') {
      this.cancel(key); this.activityQueue.delete(activity.id); this.store.upsertActivity(activity); return;
    }
    this.activityQueue.set(activity.id, activity);
    if (!this.timers.has(key)) this.schedule(key, () => {
      const value = this.activityQueue.get(activity.id);
      this.activityQueue.delete(activity.id);
      if (value) this.store.upsertActivity(value);
    }, 80);
  }
  private async tool(agent: Participant, name: string, rawArgs: unknown, callId: string) {
    if (this.store.getSession(agent.sessionId).status === 'paused' || this.store.getParticipant(agent.sessionId, agent.id).pausedByHuman) throw new Error('Agent is paused');
    if (name === 'send_group_message' || name === 'send_dm') {
      const args = (name === 'send_dm' ? messageArgs.extend({ recipient_id: z.string().min(1) }) : messageArgs).parse(rawArgs);
      const message = this.store.sendMessage(agent.sessionId, agent.id, { body: args.body, replyTo: args.reply_to, recipientId: 'recipient_id' in args ? args.recipient_id as string : undefined, requestId: `tool:${agent.id}:${callId}` });
      this.onMessage(message); return { messageId: message.id, sequence: message.sequence };
    }
    if (name === 'read_group_messages') {
      const args = z.object({ after_sequence: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).parse(rawArgs);
      const snapshot = this.store.snapshot(agent.sessionId); const group = snapshot.conversations.find(c => c.kind === 'group')!;
      const history = snapshot.messages.filter(m => m.conversationId === group.id);
      const all = history.filter(m => m.sequence > args.after_sequence);
      const page = all.slice(0, args.limit);
      const current = this.store.getParticipant(agent.sessionId, agent.id);
      const lastSequence = page.at(-1)?.sequence;
      // Only consume a contiguous prefix of group history; explicit reads may skip ahead.
      const skippedUnread = history.some(m => m.sequence > current.groupCursor && m.sequence <= args.after_sequence);
      if (lastSequence !== undefined && lastSequence > current.groupCursor && !skippedUnread) {
        this.store.updateParticipant(agent.sessionId, agent.id, { groupCursor: lastSequence });
      }
      return { messages: page.map(m => ({ ...m, senderName: snapshot.participants.find(p => p.id === m.senderId)?.name })), hasMore: all.length > page.length, nextSequence: page.at(-1)?.sequence ?? args.after_sequence };
    }
    if (name === 'web_fetch' && agent.webFetch) return webFetch(z.object({ url: z.string().url() }).parse(rawArgs).url);
    if (name === 'list_shared_files') {
      const args = z.object({ path: z.string().min(1).max(300).optional(), offset: z.number().int().min(0).default(0) }).parse(rawArgs);
      return listSharedFiles(experimentDirectory(this.dataDir, agent.sessionId), args);
    }
    if (name === 'read_shared_file') {
      const args = z.object({ path: z.string().min(1).max(300), offset: z.number().int().min(0).default(0) }).parse(rawArgs);
      return readSharedFile(experimentDirectory(this.dataDir, agent.sessionId), args.path, args.offset);
    }
    if (name === 'write_shared_file') {
      const args = z.object({ path: z.string().min(1).max(300), text: z.string().max(200000), expected_revision: z.string().nullable() }).parse(rawArgs);
      assertSharedWritePath(args.path);
      const reviewFile = /^reviews\/(\d+)\.md$/.exec(args.path);
      if (reviewFile && agent.paperReview) {
        const number = Number(reviewFile[1]);
        if (args.path !== `reviews/${String(number).padStart(4, '0')}.md`) throw new Error('Use the canonical review path reviews/NNNN.md');
        const paper = this.store.recordPaperReview(agent.sessionId, agent.id, number, 'reviewed', args.text, { expectedRevision: args.expected_revision });
        const saved = readSharedFile(experimentDirectory(this.dataDir, agent.sessionId), args.path);
        return { path: args.path, revision: saved.revision, paperNumber: paper.number, status: paper.status };
      }
      return writeSharedFile(experimentDirectory(this.dataDir, agent.sessionId), args.path, args.text, args.expected_revision);
    }
    if (name === 'cache_paper' && agent.paperReview) {
      const args = z.object({ paper_number: z.number().int().min(1) }).parse(rawArgs);
      const paper = this.store.readPapers(agent.sessionId, { after: args.paper_number - 1, limit: 1 }).papers[0];
      if (!paper || paper.number !== args.paper_number) throw new Error('Unknown paper');
      const generation = this.generations.get(agent.sessionId) || 0;
      const agentGeneration = this.paperGenerations.get(agent.id) || 0;
      return cachePaper(this.dataDir, agent.sessionId, paper, { shouldStart: () =>
        !this.closed && generation === (this.generations.get(agent.sessionId) || 0) &&
        agentGeneration === (this.paperGenerations.get(agent.id) || 0) &&
        this.store.getSession(agent.sessionId).status !== 'paused' &&
        !this.store.getParticipant(agent.sessionId, agent.id).pausedByHuman });
    }
    if (name === 'read_papers' && agent.paperReview) {
      const args = z.object({ after_number: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(10).default(5), status: z.enum(['all', 'pending', 'reviewed', 'unavailable']).default('all'), assigned_to_self: z.boolean().default(false) }).parse(rawArgs);
      const page = this.store.readPapers(agent.sessionId, { after: args.after_number, limit: args.limit, status: args.status === 'all' ? undefined : args.status, reviewerId: args.assigned_to_self ? agent.id : undefined });
      return { ...page, papers: page.papers.map(({ review, ...paper }) => ({ ...paper, reviewPath: review === null ? null : `reviews/${String(paper.number).padStart(4, '0')}.md` })) };
    }
    if (name === 'record_paper_review' && agent.paperReview) {
      const args = z.object({ paper_number: z.number().int().min(1), status: z.enum(['reviewed', 'unavailable']), review: z.string().trim().min(1).max(6000) }).parse(rawArgs);
      return this.store.recordPaperReview(agent.sessionId, agent.id, args.paper_number, args.status, args.review);
    }
    throw new Error(`Tool ${name} is not available`);
  }
  private async runAgent(sessionId: string, agentId: string, kind: 'round' | 'dm'): Promise<RuntimeTurnResult> {
    if (this.active.has(agentId)) throw new Error('Agent is already working');
    const snapshot = this.store.snapshot(sessionId); const agent = this.store.getParticipant(sessionId, agentId);
    const reason = this.guard(snapshot.session);
    if (reason) { await this.pause(sessionId, reason); return { turnId: '', status: 'interrupted', error: reason }; }
    if (snapshot.session.status === 'paused' || agent.pausedByHuman) return { turnId: '', status: 'interrupted' };
    const input = this.input(snapshot, agent, kind); const runtime = this.getRuntime(agent);
    this.store.updateSession(sessionId, { turnCount: snapshot.session.turnCount + 1 });
    this.store.updateParticipant(sessionId, agentId, { status: 'thinking' });
    let settle!: (result: RuntimeTurnResult) => void;
    const settled = new Promise<RuntimeTurnResult>(resolve => { settle = resolve; });
    const active: Active = { runtime, turnId: '', deadline: null, settled, sessionId, deliveryIds: input.deliveryIds, inputCursor: input.cursor, acceptsSteering: true, acknowledgedDeliveryIds: new Set() };
    this.active.set(agentId, active);
    const deliveryMarker = `input-${randomUUID()}`;
    // Uncertain until the runtime accepts a turn; never silently replay after a crash.
    this.store.markDeliveries(input.deliveryIds, 'uncertain', deliveryMarker);
    let deadlineReached = false;
    if (snapshot.session.settings.turnTimeoutMs > 0) active.deadline = this.clock.setTimeout(() => {
      deadlineReached = true;
      void this.interruptAgent(agentId);
      this.store.updateParticipant(sessionId, agentId, { pausedByHuman: true, status: 'paused' });
      this.system(agent, active.turnId || deliveryMarker, 'Turn deadline reached', 'interrupted');
      void runtime.close();
    }, snapshot.session.settings.turnTimeoutMs);
    let result: RuntimeTurnResult;
    try {
      result = await runtime.run({ text: input.text, messageId: deliveryMarker });
    } catch (error) { result = { turnId: active.turnId, status: 'failed', error: String(error) }; }
    finally { if (active.deadline !== null) this.clock.clearTimeout(active.deadline); active.acceptsSteering = false; }
    active.outcome = result.status; // Captured by late steering receipts even after this slot is released.
    if (result.inputState === 'not-submitted') this.store.markDeliveries(input.deliveryIds, 'pending');
    if (result.turnId) {
      active.turnId = result.turnId;
      for (const id of input.deliveryIds) active.acknowledgedDeliveryIds.add(id);
      this.store.updateParticipant(sessionId, agentId, { groupCursor: Math.max(this.store.getParticipant(sessionId, agentId).groupCursor, input.cursor) });
    }
    this.recordAcknowledgedDeliveries(active, [...active.acknowledgedDeliveryIds]);
    const outcomeText = result.error || (result.status === 'completed' ? 'Turn completed' : `Turn ${result.status}`);
    this.system(agent, result.turnId || deliveryMarker, deadlineReached ? `Turn deadline reached. ${outcomeText}` : outcomeText, result.status);
    // Reserve the slot until an interrupted runtime is fully closed and removed.
    if (result.status !== 'completed') { await runtime.close(); this.runtimes.delete(agentId); }
    this.active.delete(agentId);
    const current = this.store.getParticipant(sessionId, agentId);
    const session = this.store.getSession(sessionId);
    const paused = session.status === 'paused' || current.pausedByHuman;
    this.store.updateParticipant(sessionId, agentId, { status: paused ? 'paused' : result.status === 'failed' ? 'failed' : 'idle' });
    settle(result);
    if (result.status === 'failed') await this.pause(sessionId, `${agent.name}: ${result.error || 'Agent failed'}`);
    // An active round advancer must record its opportunity outcome before pausing.
    else if (kind === 'dm' && !this.advancing.has(sessionId) && session.status !== 'paused' && session.settings.maxTurns > 0 && session.turnCount >= session.settings.maxTurns) await this.pause(sessionId, 'Turn limit reached');
    else if (!paused) this.scheduleDelivery(sessionId, agentId);
    return result;
  }
  private system(agent: Participant, turnId: string, text: string, status: Activity['status']) {
    const time = this.iso();
    this.store.upsertActivity({ id: `${agent.id}:turn:${turnId}`, sessionId: agent.sessionId, agentId: agent.id, turnId, kind: 'system', title: 'Turn lifecycle', text, status, createdAt: time, updatedAt: time });
  }
  private async deliver(sessionId: string, agentId: string) {
    if (this.closed || this.delivering.has(agentId)) return;
    if (this.store.getSession(sessionId).status === 'paused' || this.store.getParticipant(sessionId, agentId).pausedByHuman) return;
    if (!this.store.pendingDeliveries(sessionId, agentId).length) return;
    this.delivering.add(agentId);
    try {
      const active = this.active.get(agentId);
      if (active) {
        if (!active.acceptsSteering || !active.turnId) return; // Initialization or cleanup will flush the mailbox.
        const input = this.input(this.store.snapshot(sessionId), this.store.getParticipant(sessionId, agentId), 'dm');
        this.store.markDeliveries(input.deliveryIds, 'uncertain', active.turnId);
        const accepted = await active.runtime.steer({ text: input.text, messageId: `input-${randomUUID()}` });
        if (accepted) this.recordAcknowledgedDeliveries(active, input.deliveryIds);
        else this.store.markDeliveries(input.deliveryIds, 'pending');
        if (accepted) this.store.updateParticipant(sessionId, agentId, { groupCursor: Math.max(this.store.getParticipant(sessionId, agentId).groupCursor, input.cursor) });
      } else {
        // runAgent synchronously reserves the active slot before its first await.
        // Keep the mailbox free so later DMs can steer this new turn.
        void this.runAgent(sessionId, agentId, 'dm').catch(error => this.pause(sessionId, `DM turn failed: ${String(error)}`));
      }
    } catch (error) { await this.pause(sessionId, `DM delivery needs attention: ${String(error)}`); }
    finally {
      this.delivering.delete(agentId);
      if (this.store.getSession(sessionId).status !== 'paused' && this.store.pendingDeliveries(sessionId, agentId).length) this.scheduleDelivery(sessionId, agentId, 100);
    }
  }
  private async advance(sessionId: string) {
    if (this.closed || this.advancing.has(sessionId)) return;
    const initial = this.store.getSession(sessionId);
    if (initial.status !== 'running') return;
    this.advancing.add(sessionId);
    const generation = this.generations.get(sessionId) || 0;
    const cancelled = () => this.store.getSession(sessionId).status === 'paused' || generation !== (this.generations.get(sessionId) || 0);
    try {
      const limit = this.guard(initial); if (limit) { await this.pause(sessionId, limit); return; }
      let snapshot = this.store.snapshot(sessionId);
      let round = snapshot.rounds.find(r => r.status === 'running');
      if (!round) {
        if (initial.settings.maxRounds > 0 && initial.roundNumber >= initial.settings.maxRounds) { await this.pause(sessionId, 'Round limit reached'); return; }
        const agents = snapshot.participants.filter(p => p.kind === 'agent');
        const offset = initial.roundNumber % agents.length;
        const order = [...agents.slice(offset), ...agents.slice(0, offset)];
        round = { id: randomUUID(), sessionId, number: initial.roundNumber + 1, status: 'running', startedAt: this.iso(), completedAt: null, startSequence: this.groupSequence(snapshot), opportunities: order.map(p => ({ agentId: p.id, status: 'pending', inputSequence: 0, turnId: null })) };
        this.store.updateSession(sessionId, { roundNumber: round.number }); this.store.saveRound(round);
      }
      for (const opportunity of round.opportunities) {
        if (opportunity.status !== 'pending') continue;
        if (cancelled()) return;
        let agent = this.store.getParticipant(sessionId, opportunity.agentId);
        if (agent.pausedByHuman) { opportunity.status = 'skipped'; this.store.saveRound(round); continue; }
        const busy = this.active.get(agent.id);
        if (busy) await busy.settled;
        if (cancelled()) return;
        agent = this.store.getParticipant(sessionId, agent.id);
        if (agent.pausedByHuman) { opportunity.status = 'skipped'; this.store.saveRound(round); continue; }
        snapshot = this.store.snapshot(sessionId);
        if (snapshot.session.settings.maxTurns > 0 && snapshot.session.turnCount >= snapshot.session.settings.maxTurns) { await this.pause(sessionId, 'Turn limit reached'); return; }
        opportunity.status = 'running'; opportunity.inputSequence = this.groupSequence(snapshot); this.store.saveRound(round);
        const beforeSequence = opportunity.inputSequence;
        const result = await this.runAgent(sessionId, agent.id, 'round');
        if (cancelled()) return;
        opportunity.turnId = result.turnId;
        const after = this.store.snapshot(sessionId); const group = after.conversations.find(c => c.kind === 'group')!;
        opportunity.status = result.status !== 'completed' ? 'failed' : after.messages.some(m => m.conversationId === group.id && m.senderId === agent.id && m.sequence > beforeSequence) ? 'spoke' : 'passed';
        this.store.saveRound(round);
      }
      if (cancelled()) return;
      round.status = 'completed'; round.completedAt = this.iso(); this.store.saveRound(round);
      snapshot = this.store.snapshot(sessionId);
      if (snapshot.session.settings.maxTurns > 0 && snapshot.session.turnCount >= snapshot.session.settings.maxTurns) { await this.pause(sessionId, 'Turn limit reached'); return; }
      if (snapshot.session.settings.maxRounds > 0 && round.number >= snapshot.session.settings.maxRounds) { await this.pause(sessionId, 'Round limit reached'); return; }
      const pendingWork = snapshot.participants.some(p => p.kind === 'agent' && !p.pausedByHuman && (this.active.has(p.id) || this.store.pendingDeliveries(sessionId, p.id).length > 0 || this.hasPendingPapers(p)));
      const allQuiet = round.opportunities.every(o => o.status === 'passed' || o.status === 'skipped');
      if (allQuiet && !pendingWork && this.groupSequence(snapshot) === round.startSequence) this.store.updateSession(sessionId, { status: 'idle', reason: 'Everyone passed. Waiting for a new message.', nextRoundAt: null });
      else {
        this.store.updateSession(sessionId, { status: 'cooldown', nextRoundAt: new Date(this.clock.now() + snapshot.session.settings.roundDelayMs).toISOString() });
        this.schedule(sessionId, () => { this.store.updateSession(sessionId, { status: 'running', nextRoundAt: null }); this.kick(sessionId); }, snapshot.session.settings.roundDelayMs);
      }
    } finally {
      this.advancing.delete(sessionId);
      if (!this.closed && generation !== (this.generations.get(sessionId) || 0) && this.store.getSession(sessionId).status === 'running') this.kick(sessionId);
    }
  }
  private groupSequence(snapshot: Snapshot) { const group = snapshot.conversations.find(c => c.kind === 'group'); return Math.max(0, ...snapshot.messages.filter(m => m.conversationId === group?.id).map(m => m.sequence)); }
  async shutdown() {
    this.closed = true; this.store.off('event', this.eventListener); for (const key of this.timers.keys()) this.cancel(key);
    for (const session of this.store.listSessions()) if (session.status !== 'paused') await this.pause(session.id, 'Server stopped; resume to continue');
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.close())); this.runtimes.clear();
  }
}
