import type { Activity, Participant } from '../../shared/types.js';
export interface RuntimeInput { text: string; messageId: string }
export interface RuntimeTurnResult { turnId: string; status: 'completed' | 'interrupted' | 'failed'; error?: string; inputState?: 'not-submitted' | 'accepted' | 'uncertain' }
export interface RuntimeHooks {
  onActivity: (activity: Activity) => void;
  onThread: (threadId: string) => void;
  onUsage: (tokens: number) => void;
  onTurnStarted: (turnId: string) => void;
  onTool: (name: string, args: unknown, callId: string) => Promise<unknown>;
}
export interface AgentRuntime {
  run(input: RuntimeInput): Promise<RuntimeTurnResult>;
  steer(input: RuntimeInput): Promise<boolean>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export type RuntimeFactory = (agent: Participant, hooks: RuntimeHooks) => AgentRuntime;
