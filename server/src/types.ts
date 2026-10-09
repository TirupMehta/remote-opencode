// Shared types. These mirror the *verified* subset of the OpenCode server API
// (opencode 1.18.x, see /doc on a local `opencode serve`). Unknown fields are
// tolerated at runtime; only these are relied upon.

export interface SessionModel {
  id: string;
  providerID: string;
  variant?: string;
}

export interface OpenCodeSession {
  id: string;
  slug?: string;
  projectID?: string;
  directory: string;
  path?: string;
  title: string;
  agent?: string;
  model?: SessionModel;
  version?: string;
  shareUrl?: string | null;
  time: { created: number; updated: number };
}

export type SessionExecutionState =
  | 'running' // our managed server reports busy for this session
  | 'active-external' // recent message activity, driven by another process (TUI/CLI)
  | 'attention' // provider retry / error surfaced via status or events
  | 'idle';

export interface SessionView extends OpenCodeSession {
  projectName: string;
  state: SessionExecutionState;
  controllable: boolean; // false when outside the project allowlist (read-only)
  hidden: boolean; // archived/hidden locally, history intact
  lastActivity: number;
  preview: string; // latest user/assistant text snippet, may be empty
  messageCount?: number;
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  agent?: string;
  model?: SessionModel;
  time: { created: number; completed?: number };
  error?: unknown;
}

export interface MessagePart {
  id: string;
  messageID: string;
  sessionID: string;
  type: string;
  [key: string]: unknown;
}

export interface SessionMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

export interface ProviderModel {
  id: string;
  providerID: string;
  name: string;
}

export interface AgentInfo {
  name: string;
  description?: string;
}

export interface PtyInfo {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
  exitCode?: number;
}

// Events emitted by this backend to phone clients over /api/stream.
export type ClientEventType =
  | 'sync'
  | 'sessions'
  | 'session.status'
  | 'session.message'
  | 'session.delta'
  | 'session.event'
  | 'pty'
  | 'health';

export interface ClientEvent {
  id: number;
  type: ClientEventType;
  sessionID?: string;
  data: unknown;
}
