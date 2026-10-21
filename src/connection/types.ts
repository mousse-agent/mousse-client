// The boundary between the phone UI and the connection layer. The UI only
// talks to MousseConnection; the Net and Mousse ID implementation lives in src/net and
// src/mousseId. Keep this file small and stable: both sides depend on it.
import type { ComputerSpeech } from './speech'

export interface Account {
  id: string
  email: string | null
}

export type AccountState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; account: Account; idOrigin: string; devices?: { used: number; limit: number } }

export type ComputerKind = 'computer' | 'phone'

export interface Computer {
  nodeId: string
  name: string
  kind: ComputerKind
  online: boolean
  /** This phone holds a delegation for the computer and can open it. */
  enrolled: boolean
  lastSeenAt?: number
}

export type EnrollmentStage =
  | 'requesting'
  | 'waiting-approval'
  | 'connecting'
  | 'done'
  | 'denied'
  | 'expired'
  | 'error'

export interface EnrollmentProgress {
  stage: EnrollmentStage
  /** Six digits shown on the phone and the computer while waiting for approval. */
  matchCode?: string
  message?: string
}

export interface Project {
  id: string
  name: string
  path?: string
}

export interface ThreadSummary {
  id: string
  projectId?: string
  title: string
  updatedAt: number
  pinned?: boolean
  settled?: boolean
  active?: boolean
}

/** A thread's run status as the desktop sidebar shows it. Idle threads have none. */
export type RunState = 'processing' | 'awaiting_input' | 'completed' | 'failed'

export interface ThreadStatus {
  state: RunState
  /** When the running turn started, ms. */
  since?: number
  error?: string
}

export interface ListProject {
  id: string
  name: string
  path?: string
  /** Sidebar position on the computer. */
  order: number
  pinned: boolean
}

export interface ListThread {
  id: string
  title: string
  projectId?: string
  createdAt: number
  updatedAt: number
  /** Sidebar position within its project on the computer; lower comes first. */
  order: number
  pinned: boolean
  settled: boolean
  /** False for empty drafts, which the sidebar hides. */
  started: boolean
  worktree?: boolean
}

/** A conversation with agents (the desktop's Chats tab). Its messages live in a backing thread. */
export interface ListChat {
  id: string
  kind: 'direct' | 'group'
  name: string
  /** The thread that mirrors the chat; absent for Space conversations. */
  threadId?: string
  projectId?: string
  /** Published to a Space: it opens only on the computer. */
  network: boolean
  agents: string[]
  updatedAt: number
  preview?: string
  run?: { id: string; state: string; startedAt: number; error?: string }
}

/** Everything the phone's Projects, Threads and Chats tabs show for one computer. */
export interface ComputerLists {
  projects: ListProject[]
  threads: ListThread[]
  chats: ListChat[]
  /** Run status of the threads that are not idle, by thread id. */
  status: Record<string, ThreadStatus>
  receivedAt: number
}

/** How the lists reach the phone: following the computer live, asked for every few seconds (older desktops), or failing. */
export type ListsState = 'loading' | 'live' | 'polling' | 'error'

export interface ListsHandlers {
  lists(lists: ComputerLists): void
  state?(state: ListsState, error?: Error): void
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

/**
 * What a timeline row shows, after the desktop's ChatMessage `kind`. Plain user and assistant
 * text is `message`; the rest mirror the desktop's timeline rows.
 */
export type ChatItemKind = 'message' | 'thinking' | 'tool' | 'plan' | 'progress' | 'warning' | 'compaction' | 'handoff'

/** A tool call, with the desktop's normalized name (Read, Edit, Write, Bash, Grep, Glob, Task, Mcp, Generic…). */
export interface ChatToolCall {
  name: string
  /** The provider's own name for the tool, when known. */
  rawName?: string
  /** The MCP server, for MCP tools. */
  server?: string
  title: string
  summary: string
  details: string[]
  /** Structured arguments (JSON object). */
  input?: Record<string, unknown>
  /** The result: text, or parsed JSON when the result is JSON. */
  output?: unknown
}

export interface ChatImage {
  name: string
  mimeType: string
  /** Base64 without a `data:` prefix. Missing on old messages saved without the image. */
  data?: string
}

/** A desktop reference pill in a user message (a file, thread, project, terminal, browser tab or agent). */
export interface ChatReference {
  kind: string
  title: string
  path?: string
  url?: string
}

export interface ChatResponseMeta {
  modelName?: string
  totalResponseTimeMs?: number
  tokensUsed?: number
  tokensPerSecond?: number
}

export interface ChatItem {
  id: string
  role: ChatRole
  text: string
  createdAt: number
  status?: 'streaming' | 'done' | 'error'
  toolName?: string
  /** Missing on items made by older code paths; read as `message`. */
  kind?: ChatItemKind
  turnId?: string
  tool?: ChatToolCall
  /** A plan card: the plan's title and markdown. */
  plan?: { title: string; markdown: string; request?: string }
  images?: ChatImage[]
  /** Names of attached files that are not images. */
  files?: string[]
  references?: ChatReference[]
  /** The error the computer reported for this message. */
  error?: { message: string; code?: string }
  meta?: ChatResponseMeta
  /** A context handoff between models: "provider/model" labels. */
  handoff?: { from: string; to: string }
  /** The reply stopped before it finished. */
  incomplete?: boolean
}

/** The desktop's turn phase (shared/types.ts TurnPhase). */
export type TurnPhase =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'awaiting_input'
  | 'finalizing'
  | 'completed'
  | 'stopped'
  | 'failed'

export interface PendingQuestionOption {
  id: string
  label: string
}

export interface PendingQuestion {
  id: string
  prompt: string
  options: PendingQuestionOption[]
  allowMultiple?: boolean
}

/** Questions or an approval the computer is waiting on. Approvals are one question with id `approval`. */
export interface PendingQuestions {
  requestId: string
  questions: PendingQuestion[]
}

/** Answers by question id: an option id or typed text, or a list of them for multiple choice. */
export type QuestionAnswers = Record<string, string | string[]>

/** Thread state beside the items. */
export interface ThreadDisplayState {
  /** The latest turn phase the computer reported. */
  phase?: TurnPhase
  /** When the current turn started, from the computer. */
  turnStartedAt?: number
  /** The turn's error, when the phase is `failed`. */
  turnError?: string
  questions: PendingQuestions[]
  /** The computer could not reach its model provider. */
  connectionFailed?: string
}

/** A computer's model choice for a thread. The effort is a `:<effort>` suffix on `model`. */
export interface ModelSelection {
  instanceId?: string
  llmProvider: string
  model: string
}

export interface LlmModelOption {
  id: string
  label: string
  /** Reasoning effort levels the model supports (without "off"). */
  efforts?: string[]
  speed?: 'fast' | 'slow'
}

export interface LlmProviderOption {
  id: string
  /** Provider instance serving these models. */
  instanceId?: string
  label: string
  models: LlmModelOption[]
}

/** A built-in mode ("plan", "agent", "build") or one skill for a single message. */
export type ChatMode = string | { type: 'skill'; skillId: string }

export interface ComposerSkill {
  id: string
  name: string
  description: string
}

export interface ComposerCommand {
  name: string
  description: string
  aliases?: string[]
  argsHint?: string
}

/** What the computer's composer offers: its models, default model, modes, skills and slash commands. */
export interface ComposerOptions {
  providers: LlmProviderOption[]
  defaultModel?: ModelSelection
  modes: string[]
  skills: ComposerSkill[]
  commands: ComposerCommand[]
}

/** An image to send, as base64 without a `data:` prefix. */
export interface ImageAttachment {
  name: string
  mimeType: string
  data: string
}

export interface SendOptions {
  mode?: ChatMode
  images?: ImageAttachment[]
}

/** A message waiting in the thread's queue on the computer. */
export interface QueuedMessage {
  id: string
  content: string
  mode?: ChatMode
  imageCount: number
  enqueuedAt: number
  /** "steer" items join the running turn instead of starting a new one. */
  intent: string
  state: string
}

/** The thread fields the composer needs. */
export interface ThreadDetails {
  id: string
  projectId?: string
  model?: ModelSelection
}

export interface ContextUsage {
  percent: number
  used: number
  limit: number
  modelName: string | null
  categories: Array<{ label: string; color: string; tokens: number }>
}

export type SessionState = 'connecting' | 'open' | 'closed'

/** Why a session closed: the user's computers removed this phone, or anything else (network, timeout, the app). */
export type SessionEndReason = 'removed' | 'ended'

export interface ComputerSession {
  readonly nodeId: string
  state(): SessionState
  onStateChange(listener: (state: SessionState) => void): () => void
  /** Set when the session closed; read it from an onStateChange listener. */
  endReason(): SessionEndReason | undefined
  /** A short, plain-text description of why the session closed, when one is known. */
  endMessage?(): string | undefined
  listProjects(): Promise<Project[]>
  listThreads(filter?: { projectId?: string; query?: string }): Promise<ThreadSummary[]>
  createThread(input: { projectId: string; title?: string }): Promise<ThreadSummary>
  /**
   * Calls onItems with the full item list, and the thread's display state when the session knows
   * it, on open and after every change. Returns an unsubscribe.
   */
  openThread(threadId: string, onItems: (items: ChatItem[], state?: ThreadDisplayState) => void): Promise<() => void>
  /** Answers questions the computer is waiting on. False when they are no longer pending. */
  answerQuestions?(threadId: string, requestId: string, answers: QuestionAnswers): Promise<boolean>
  /** Dismisses questions the computer is waiting on. False when they are no longer pending. */
  dismissQuestions?(threadId: string, requestId: string): Promise<boolean>
  send(threadId: string, text: string, options?: SendOptions): Promise<void>
  abort(threadId: string): Promise<void>
  isTurnActive(threadId: string): Promise<boolean>
  /**
   * Follows the computer's projects, threads, chats and their run status. Calls `lists` with the
   * current lists right away when known, then after every change. Returns an unsubscribe.
   */
  watchLists(handlers: ListsHandlers): () => void
  /** Models, modes, skills and commands for the composer; skills follow the thread's project. */
  composerOptions(threadId?: string): Promise<ComposerOptions>
  getThread(threadId: string): Promise<ThreadDetails>
  /** Stores the thread's model and effort on the computer. */
  setThreadModel(threadId: string, selection: ModelSelection): Promise<void>
  /** Sends guidance into the running turn. */
  steer(threadId: string, text: string): Promise<void>
  /** Queues a message to run after the current turn. */
  enqueue(threadId: string, text: string, options?: SendOptions): Promise<void>
  listQueue(threadId: string): Promise<QueuedMessage[]>
  removeQueued(threadId: string, itemId: string): Promise<void>
  reorderQueue(threadId: string, orderedIds: string[]): Promise<void>
  /** Moves a queued message into the running turn. */
  steerQueued(threadId: string, itemId: string): Promise<void>
  contextUsage(threadId: string): Promise<ContextUsage | undefined>
  /** Dictation and read aloud with the computer's speech models; absent when unavailable. */
  readonly speech?: ComputerSpeech
  close(): void
}

export interface MousseConnection {
  account(): AccountState
  onAccountChange(listener: (state: AccountState) => void): () => void
  signInWithPassword(email: string, password: string): Promise<void>
  /** Signs in with Google in the system browser and returns to the app through a deep link. */
  signInWithGoogle(): Promise<void>
  signOut(): Promise<void>
  /** Opens the Mousse ID sign-up page in the system browser. */
  openSignUp(): Promise<void>
  listComputers(): Promise<Computer[]>
  enrollWithComputer(
    nodeId: string,
    deviceName: string,
    onProgress: (progress: EnrollmentProgress) => void,
  ): Promise<void>
  /** Accepts the text of a `mousse://net/join?...` QR code. */
  enrollFromQr(payload: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void>
  openComputer(nodeId: string): Promise<ComputerSession>
}
