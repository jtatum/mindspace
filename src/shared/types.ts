export const DEFAULT_MODEL = 'gpt-5.6-terra';
export const DEFAULT_EFFORT = 'high';
export type AgentStatus = 'idle' | 'queued' | 'thinking' | 'tool' | 'paused' | 'failed';
export type SessionStatus = 'paused' | 'running' | 'cooldown' | 'idle';
export interface Identity { id: string; name: string; token: string }
// Zero disables a run limit. Positive values remain supported for API clients.
export interface Settings { roundDelayMs: number; turnTimeoutMs: number; maxRounds: number; maxTurns: number; maxTokens: number; maxDurationMs: number }
export const DEFAULT_SETTINGS: Settings = { roundDelayMs: 10000, turnTimeoutMs: 0, maxRounds: 0, maxTurns: 0, maxTokens: 0, maxDurationMs: 0 };
export interface Session { id: string; title: string; task: string; status: SessionStatus; reason: string | null; createdAt: string; startedAt: string | null; nextRoundAt: string | null; roundNumber: number; turnCount: number; settings: Settings; runtimeMode: 'codex' | 'simulation' }
export interface Participant { id: string; sessionId: string; kind: 'human' | 'agent'; name: string; color: string; instructions: string; model: string; effort: string; webFetch: boolean; status: AgentStatus; threadId: string | null; tokensUsed: number | null; groupCursor: number; pausedByHuman?: boolean; paperReview?: boolean }
export interface Conversation { id: string; sessionId: string; kind: 'group' | 'dm'; participantIds: string[]; createdAt: string }
export interface Message { id: string; sessionId: string; conversationId: string; senderId: string; body: string; sequence: number; createdAt: string; replyTo: string | null }
export interface Delivery { id: string; sessionId: string; agentId: string; messageId: string; state: 'pending' | 'accepted' | 'uncertain'; turnId: string | null }
export interface Activity { id: string; sessionId: string; agentId: string; turnId: string; kind: 'message' | 'reasoning' | 'tool' | 'error' | 'system'; title: string; text: string; status: 'inProgress' | 'completed' | 'failed' | 'interrupted'; arguments?: unknown; result?: unknown; createdAt: string; updatedAt: string }
export interface Opportunity { agentId: string; status: 'pending' | 'running' | 'spoke' | 'passed' | 'failed' | 'skipped'; inputSequence: number; turnId: string | null }
export interface Round { id: string; sessionId: string; number: number; status: 'running' | 'completed' | 'interrupted'; startedAt: string; completedAt: string | null; startSequence: number; opportunities: Opportunity[] }
export interface SessionEvent { sequence: number; sessionId: string; type: string; data: unknown; createdAt: string }
export interface Snapshot { session: Session; participants: Participant[]; conversations: Conversation[]; messages: Message[]; activities: Activity[]; rounds: Round[]; deliveries: Delivery[]; eventSeq: number; paperProgress?: PaperProgress }
export interface CreateSessionInput { title: string; task: string; agents: Array<{ name: string; instructions: string; webFetch?: boolean }>; settings?: Partial<Settings> }
export interface SendMessageInput { conversationId?: string; recipientId?: string; body: string; replyTo?: string; requestId: string }
export interface RuntimeHealth { mode: 'codex' | 'simulation'; available: boolean; version?: string; model: string; effort: string; message?: string }
export interface Paper { number: number; title: string; url: string; reviewerId: string; status: 'pending' | 'reviewed' | 'unavailable'; review: string | null }
export interface PaperProgress { total: number; pending: number; reviewed: number; unavailable: number }
