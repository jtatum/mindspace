import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_SETTINGS,
  type Activity, type Conversation, type CreateSessionInput, type Delivery,
  type Identity, type Message, type Participant, type Round, type SendMessageInput,
  type Session, type SessionEvent, type Snapshot,
} from '../shared/types.js';

type Human = Pick<Identity, 'id' | 'name'>;
type RecordRow = { data: string };
const colors = ['#818cf8', '#22c55e', '#f59e0b', '#ec4899', '#38bdf8'];
const now = () => new Date().toISOString();
const decode = <T>(row: unknown): T | undefined => row ? JSON.parse((row as RecordRow).data) as T : undefined;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class StoreError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

/** SQLite is the source of truth. Events leave this process only after commit. */
export class Store extends EventEmitter {
  private db: DatabaseSync;
  private transactionEvents: SessionEvent[] | null = null;

  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), pair_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,pair_key));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), sender_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,sender_id,request_id), UNIQUE(session_id,sequence));
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), agent_id TEXT NOT NULL, state TEXT NOT NULL, turn_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delivery_mailbox ON deliveries(session_id,agent_id,state);
      CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), agent_id TEXT NOT NULL, status TEXT NOT NULL, turn_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_session ON activities(session_id);
      CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id,sequence);
      PRAGMA user_version=1;
    `);
  }

  private transaction<T>(work: () => T): T {
    if (this.transactionEvents) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionEvents = [];
    let result: T;
    let events: SessionEvent[];
    try {
      result = work();
      this.db.exec('COMMIT');
      events = this.transactionEvents;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionEvents = null;
    }
    for (const event of events) this.emit('event', event);
    return result;
  }

  private event(sessionId: string, type: string, data: unknown): void {
    if (!this.transactionEvents) throw new Error('Events require a transaction');
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(session_id,type,data,created_at) VALUES(?,?,?,?)').run(sessionId, type, JSON.stringify(data), createdAt);
    this.transactionEvents.push({ sequence: Number(result.lastInsertRowid), sessionId, type, data, createdAt });
  }

  createIdentity(name: string): Identity {
    name = name.trim();
    // Match the API schemas' Unicode code-point limits, including supplementary characters.
    if (!name || Array.from(name).length > 80) throw new StoreError('Display name must be 1–80 characters');
    const identity = { id: randomUUID(), name, token: randomBytes(32).toString('base64url') };
    this.db.prepare('INSERT INTO identities(id,name,token_hash) VALUES(?,?,?)').run(identity.id, identity.name, tokenHash(identity.token));
    return identity;
  }

  authenticate(token: string): Human | null {
    const row = this.db.prepare('SELECT id,name FROM identities WHERE token_hash=?').get(tokenHash(token)) as Human | undefined;
    return row ? { id: row.id, name: row.name } : null;
  }

  listSessions(): Session[] {
    return this.db.prepare('SELECT data FROM sessions ORDER BY rowid DESC').all().map(row => decode<Session>(row)!);
  }

  createSession(input: CreateSessionInput, human: Human, runtimeMode: Session['runtimeMode']): Snapshot {
    if (!input.title.trim() || !input.task.trim() || input.agents.length < 3 || input.agents.length > 5) {
      throw new StoreError('A session requires a title, a task, and three to five agents');
    }
    return this.transaction(() => {
      const session: Session = {
        id: randomUUID(), title: input.title.trim(), task: input.task.trim(), status: 'paused', reason: 'Ready to start',
        createdAt: now(), startedAt: null, nextRoundAt: null, roundNumber: 0, turnCount: 0,
        settings: { ...DEFAULT_SETTINGS, ...input.settings }, runtimeMode,
      };
      this.db.prepare('INSERT INTO sessions(id,data) VALUES(?,?)').run(session.id, JSON.stringify(session));
      this.event(session.id, 'session.updated', session);
      this.joinSession(session.id, human);
      input.agents.forEach((agent, index) => {
        const participant: Participant = {
          id: randomUUID(), sessionId: session.id, kind: 'agent', name: agent.name.trim(), color: colors[index],
          instructions: agent.instructions, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, webFetch: agent.webFetch ?? false,
          status: 'paused', threadId: null, tokensUsed: null, groupCursor: 0,
        };
        this.db.prepare('INSERT INTO participants(session_id,id,data) VALUES(?,?,?)').run(session.id, participant.id, JSON.stringify(participant));
        this.event(session.id, 'participant.joined', participant);
      });
      const group: Conversation = { id: randomUUID(), sessionId: session.id, kind: 'group', participantIds: [], createdAt: now() };
      this.db.prepare('INSERT INTO conversations(id,session_id,pair_key,data) VALUES(?,?,?,?)').run(group.id, session.id, 'group', JSON.stringify(group));
      this.event(session.id, 'conversation.created', group);
      this.sendMessage(session.id, human.id, { body: session.task, requestId: 'initial-task' });
      return this.snapshot(session.id);
    });
  }

  joinSession(sessionId: string, human: Human): Participant {
    return this.transaction(() => {
      this.getSession(sessionId);
      const existing = decode<Participant>(this.db.prepare('SELECT data FROM participants WHERE session_id=? AND id=?').get(sessionId, human.id));
      if (existing) return existing;
      const identity = this.db.prepare('SELECT name FROM identities WHERE id=?').get(human.id) as { name: string } | undefined;
      if (!identity) throw new StoreError('Unknown human identity', 401);
      const participant: Participant = {
        id: human.id, sessionId, kind: 'human', name: identity.name, color: '#a1a1aa', instructions: '', model: '', effort: '',
        webFetch: false, status: 'idle', threadId: null, tokensUsed: null, groupCursor: 0,
      };
      this.db.prepare('INSERT INTO participants(session_id,id,data) VALUES(?,?,?)').run(sessionId, participant.id, JSON.stringify(participant));
      this.event(sessionId, 'participant.joined', participant);
      return participant;
    });
  }

  getSession(id: string): Session {
    const session = decode<Session>(this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id));
    if (!session) throw new StoreError('Session not found', 404);
    return session;
  }

  updateSession(id: string, changes: Partial<Session>): Session {
    return this.transaction(() => {
      const current = this.getSession(id);
      const session = { ...current, ...changes, id, createdAt: current.createdAt };
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), id);
      this.event(id, 'session.updated', session);
      return session;
    });
  }

  getParticipant(sessionId: string, id: string): Participant {
    const participant = decode<Participant>(this.db.prepare('SELECT data FROM participants WHERE session_id=? AND id=?').get(sessionId, id));
    if (!participant) throw new StoreError('Participant does not belong to this session', 403);
    return participant;
  }

  updateParticipant(sessionId: string, id: string, changes: Partial<Participant>): Participant {
    return this.transaction(() => {
      const current = this.getParticipant(sessionId, id);
      const participant = { ...current, ...changes, id, sessionId, kind: current.kind };
      this.db.prepare('UPDATE participants SET data=? WHERE session_id=? AND id=?').run(JSON.stringify(participant), sessionId, id);
      this.event(sessionId, 'participant.updated', participant);
      return participant;
    });
  }

  snapshot(sessionId: string): Snapshot {
    const session = this.getSession(sessionId);
    const records = <T>(table: string) => this.db.prepare(`SELECT data FROM ${table} WHERE session_id=? ORDER BY rowid`).all(sessionId).map(row => decode<T>(row)!);
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?').get(sessionId) as { sequence: number };
    return {
      session, participants: records<Participant>('participants'), conversations: records<Conversation>('conversations'),
      messages: records<Message>('messages'), deliveries: records<Delivery>('deliveries'), activities: records<Activity>('activities'),
      rounds: records<Round>('rounds'), eventSeq: row.sequence,
    };
  }

  sendMessage(sessionId: string, senderId: string, input: SendMessageInput): Message {
    return this.transaction(() => {
      this.getSession(sessionId);
      this.getParticipant(sessionId, senderId);
      const body = input.body.trim();
      if (!body || Array.from(body).length > 40000 || !input.requestId || Array.from(input.requestId).length > 200) throw new StoreError('A message requires a body (up to 40,000 characters) and a request ID');
      let conversation: Conversation | undefined;
      if (input.conversationId) {
        conversation = decode<Conversation>(this.db.prepare('SELECT data FROM conversations WHERE id=? AND session_id=?').get(input.conversationId, sessionId));
        if (!conversation) throw new StoreError('Conversation not found', 404);
        if (conversation.kind === 'dm' && !conversation.participantIds.includes(senderId)) throw new StoreError('You can observe this DM but cannot send as its participants', 403);
      }
      if (input.recipientId) {
        this.getParticipant(sessionId, input.recipientId);
        if (input.recipientId === senderId) throw new StoreError('Choose another participant for a DM');
        const pair = [senderId, input.recipientId].sort();
        if (conversation && (conversation.kind !== 'dm' || conversation.participantIds.join(':') !== pair.join(':'))) throw new StoreError('Conversation and recipient do not match');
        if (!conversation) {
          const key = pair.join(':');
          conversation = decode<Conversation>(this.db.prepare('SELECT data FROM conversations WHERE session_id=? AND pair_key=?').get(sessionId, key));
          if (!conversation) {
            conversation = { id: randomUUID(), sessionId, kind: 'dm', participantIds: pair, createdAt: now() };
            this.db.prepare('INSERT INTO conversations(id,session_id,pair_key,data) VALUES(?,?,?,?)').run(conversation.id, sessionId, key, JSON.stringify(conversation));
            this.event(sessionId, 'conversation.created', conversation);
          }
        }
      }
      conversation ??= decode<Conversation>(this.db.prepare("SELECT data FROM conversations WHERE session_id=? AND pair_key='group'").get(sessionId));
      if (!conversation) throw new StoreError('Group conversation is missing', 500);
      if (input.replyTo) {
        const reply = decode<Message>(this.db.prepare('SELECT data FROM messages WHERE id=? AND session_id=?').get(input.replyTo, sessionId));
        if (!reply || reply.conversationId !== conversation.id) throw new StoreError('Reply must reference a message in this conversation');
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({ body, conversationId: conversation.id, replyTo: input.replyTo ?? null })).digest('hex');
      const prior = this.db.prepare('SELECT data,fingerprint FROM messages WHERE session_id=? AND sender_id=? AND request_id=?').get(sessionId, senderId, input.requestId) as { data: string; fingerprint: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new StoreError('Request ID was already used for a different message', 409);
        return JSON.parse(prior.data) as Message;
      }
      const latest = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM messages WHERE session_id=?').get(sessionId) as { sequence: number };
      const message: Message = {
        id: randomUUID(), sessionId, conversationId: conversation.id, senderId, body, sequence: latest.sequence + 1,
        createdAt: now(), replyTo: input.replyTo ?? null,
      };
      this.db.prepare('INSERT INTO messages(id,session_id,sender_id,request_id,fingerprint,sequence,data) VALUES(?,?,?,?,?,?,?)')
        .run(message.id, sessionId, senderId, input.requestId, fingerprint, message.sequence, JSON.stringify(message));
      this.event(sessionId, 'message.created', message);
      if (conversation.kind === 'dm') {
        const recipient = this.getParticipant(sessionId, conversation.participantIds.find(id => id !== senderId)!);
        if (recipient.kind === 'agent') {
          const delivery: Delivery = { id: randomUUID(), sessionId, agentId: recipient.id, messageId: message.id, state: 'pending', turnId: null };
          this.db.prepare('INSERT INTO deliveries(id,session_id,agent_id,state,turn_id,data) VALUES(?,?,?,?,?,?)').run(delivery.id, sessionId, recipient.id, delivery.state, null, JSON.stringify(delivery));
          this.event(sessionId, 'delivery.updated', delivery);
        }
      }
      return message;
    });
  }

  pendingDeliveries(sessionId: string, agentId: string): Delivery[] {
    this.getParticipant(sessionId, agentId);
    return this.db.prepare("SELECT data FROM deliveries WHERE session_id=? AND agent_id=? AND state='pending' ORDER BY rowid").all(sessionId, agentId).map(row => decode<Delivery>(row)!);
  }

  markDeliveries(ids: string[], state: Delivery['state'], turnId?: string): void {
    this.transaction(() => {
      for (const id of ids) {
        const current = decode<Delivery>(this.db.prepare('SELECT data FROM deliveries WHERE id=?').get(id));
        if (!current) throw new StoreError('Delivery not found', 404);
        const delivery: Delivery = { ...current, state, turnId: turnId ?? current.turnId };
        this.db.prepare('UPDATE deliveries SET state=?,turn_id=?,data=? WHERE id=?').run(state, delivery.turnId, JSON.stringify(delivery), id);
        this.event(delivery.sessionId, 'delivery.updated', delivery);
      }
    });
  }

  upsertActivity(activity: Activity): void {
    this.transaction(() => {
      const participant = this.getParticipant(activity.sessionId, activity.agentId);
      if (participant.kind !== 'agent') throw new StoreError('Activity belongs to an agent');
      const existing = decode<Activity>(this.db.prepare('SELECT data FROM activities WHERE id=?').get(activity.id));
      if (existing && (existing.sessionId !== activity.sessionId || existing.agentId !== activity.agentId || existing.turnId !== activity.turnId)) throw new StoreError('Activity ownership cannot change');
      this.db.prepare('INSERT INTO activities(id,session_id,agent_id,status,turn_id,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
        .run(activity.id, activity.sessionId, activity.agentId, activity.status, activity.turnId, JSON.stringify(activity));
      this.event(activity.sessionId, 'activity.updated', activity);
    });
  }

  saveRound(round: Round): void {
    this.transaction(() => {
      this.getSession(round.sessionId);
      const existing = decode<Round>(this.db.prepare('SELECT data FROM rounds WHERE id=?').get(round.id));
      if (existing && existing.sessionId !== round.sessionId) throw new StoreError('Round ownership cannot change');
      this.db.prepare('INSERT INTO rounds(id,session_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(round.id, round.sessionId, round.status, JSON.stringify(round));
      this.event(round.sessionId, 'round.updated', round);
    });
  }

  eventsAfter(sessionId: string, sequence: number): SessionEvent[] {
    this.getSession(sessionId);
    const rows = this.db.prepare('SELECT sequence,session_id,type,data,created_at FROM events WHERE session_id=? AND sequence>? ORDER BY sequence').all(sessionId, sequence) as Array<{ sequence: number; session_id: string; type: string; data: string; created_at: string }>;
    return rows.map(row => ({ sequence: row.sequence, sessionId: row.session_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
  }

  recover(): void {
    this.transaction(() => {
      for (const session of this.listSessions()) {
        const snapshot = this.snapshot(session.id);
        const activeTurns = new Set(snapshot.activities.filter(item => item.status === 'inProgress').map(item => item.turnId));
        for (const round of snapshot.rounds.filter(round => round.status === 'running')) {
          for (const opportunity of round.opportunities) if (opportunity.turnId && opportunity.status === 'running') activeTurns.add(opportunity.turnId);
          this.saveRound({ ...round, status: 'interrupted', completedAt: now(), opportunities: round.opportunities.map(opportunity => ({ ...opportunity, status: opportunity.status === 'running' ? 'failed' : opportunity.status === 'pending' ? 'skipped' : opportunity.status })) });
        }
        for (const activity of snapshot.activities.filter(item => item.status === 'inProgress')) this.upsertActivity({ ...activity, status: 'interrupted', updatedAt: now() });
        for (const participant of snapshot.participants.filter(item => item.kind === 'agent')) {
          if (participant.status !== 'paused') this.updateParticipant(session.id, participant.id, { status: 'paused' });
        }
        // An accepted submission is not proof of consumption. Completed turns remain accepted.
        const uncertain = snapshot.deliveries.filter(delivery => delivery.state === 'accepted' && (!delivery.turnId || activeTurns.has(delivery.turnId) || !snapshot.activities.some(activity => activity.id === `${delivery.agentId}:turn:${delivery.turnId}` && activity.agentId === delivery.agentId && activity.turnId === delivery.turnId && activity.kind === 'system' && activity.status === 'completed')));
        if (uncertain.length) this.markDeliveries(uncertain.map(item => item.id), 'uncertain');
        if (session.status !== 'paused') this.updateSession(session.id, { status: 'paused', nextRoundAt: null, reason: 'Server restarted. Review interrupted work and uncertain deliveries before resuming.' });
      }
    });
  }

  close(): void { this.db.close(); this.removeAllListeners(); }
}
