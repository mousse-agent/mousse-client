import type { ComputerBots, ListBot } from './bots'
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
  /** The computer that adds devices for the account's computers (the roster authority). */
  authority?: boolean
  lastSeenAt?: number
}

/**
 * Whether this phone still has to join the account's computers, and where. One join reaches every
 * computer of the account: the authority adds the phone to the list all of them share.
 * - `joined`: the phone is already among them.
 * - `none`: the account has no computer that can add it yet.
 * - `removed`: the user's computers removed this phone; it does not join again on its own.
 * - `needed`: the phone asks `target`, the authority, to add it.
 */
export type JoinPlan =
  | { status: 'joined' }
  | { status: 'none' }
  | { status: 'removed'; computer?: string }
  | { status: 'needed'; target: { nodeId: string; name: string; online: boolean } }

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
  /** The owner's personal bots; empty on a computer that does not list them. */
  bots: ListBot[]
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

/** An in-response applet's source, as the desktop validates it (mousse/src/shared/applets.ts). */
export interface AppletSubmission {
  schemaVersion: 1
  title: string
  description: string
  html: string
  css: string
  js: string
  data?: unknown
  stateVersion: number
  appletId?: string
  expectedRevision?: string
}

/** An applet the computer published in a finished reply; without `source` the phone cannot run it. */
export interface ChatApplet {
  appletId: string
  revisionId: string
  title: string
  description: string
  source?: AppletSubmission
}

/** A reply in order: text, applets, and placeholders for applets still being written. */
export type ChatPart = { type: 'text'; text: string } | { type: 'applet'; applet: ChatApplet } | { type: 'applet-pending' }

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
  /** A reply with applets, in order; `text` then holds only its text parts. */
  parts?: ChatPart[]
  /** Mousse's line that a Stop, a restart or a crash cut the turn off: it shows nothing itself. */
  turnEnd?: TurnEnd
}

/**
 * Why a turn was cut off before it finished (desktop shared/types.ts). `user`: a person's Stop; `agent`: an agent in
 * another thread stopped it; `daemon_restart`: Mousse restarted; `crash`: Mousse quit. `tools`: what may have run.
 */
export interface TurnEnd {
  cause: 'user' | 'agent' | 'daemon_restart' | 'crash'
  tools?: string[]
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
  /** Older messages of a long thread still on the computer; `loadable` when `loadEarlier` can fetch them. */
  earlier?: { count: number; loadable: boolean }
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

/**
 * How much the agent may do without asking (the desktop's PermissionMode): `ask`, `accept_edits`
 * (edits go ahead, commands ask), `auto` (the agent's own auto mode decides) or `full` (nothing asks).
 */
export type PermissionMode = 'ask' | 'accept_edits' | 'auto' | 'full'

/** What the computer's composer offers: its models, default model, modes, skills and slash commands. */
export interface ComposerOptions {
  providers: LlmProviderOption[]
  defaultModel?: ModelSelection
  modes: string[]
  skills: ComposerSkill[]
  commands: ComposerCommand[]
  /** The computer's default permission mode, and the most it lets this phone have. */
  permission?: { defaultMode: PermissionMode; limit?: PermissionMode }
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

/**
 * What an edit of a queued message answers: the saved message, or, with `changed`, the message as it is
 * now when its text changed after the edit started; then nothing was saved.
 */
export interface QueueEditResult {
  item: QueuedMessage
  changed?: true
}

/** The thread fields the composer needs. */
export interface ThreadDetails {
  id: string
  projectId?: string
  model?: ModelSelection
  /** The thread's own permission mode; without one it follows the computer's default. */
  permissionMode?: PermissionMode
}

export interface ContextUsage {
  percent: number
  used: number
  limit: number
  modelName: string | null
  categories: Array<{ label: string; color: string; tokens: number }>
}

export type SessionState = 'connecting' | 'open' | 'closed'

/**
 * Why a session closed: the user's computers removed this phone; the path to the computer dropped
 * (the network, the Mousse ID relay restarting, the computer going away), which the phone retries
 * on its own; or anything else (a refusal, the app).
 */
export type SessionEndReason = 'removed' | 'lost' | 'ended'

/** Codes of failures that say only that the computer or Mousse ID could not be reached just now. */
const UNREACHABLE = new Set(['peer_offline', 'route_unreachable', 'deadline_exceeded', 'unavailable', 'offline', 'rate_limited'])

/** Marks a failure to reach a computer that the phone retries on its own before showing it. */
export function unreachable<T extends Error>(error: T): T {
  return Object.assign(error, { unreachable: true })
}

/** Whether a failure only says the computer or Mousse ID could not be reached just now. */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const value = error as Error & { unreachable?: unknown; code?: unknown }
  return value.unreachable === true || (typeof value.code === 'string' && UNREACHABLE.has(value.code))
}

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
  createThread(input: { projectId: string; title?: string; worktreeEnabled?: boolean }): Promise<ThreadSummary>
  /**
   * Calls onItems with the full item list, and the thread's display state when the session knows
   * it, on open and after every change. Returns an unsubscribe.
   */
  openThread(threadId: string, onItems: (items: ChatItem[], state?: ThreadDisplayState) => void): Promise<() => void>
  /** Reads the page of messages before the oldest one an open thread shows (`state.earlier`), and shows it. */
  loadEarlier?(threadId: string): Promise<void>
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
  /**
   * Replaces a queued message's text; it keeps its place in the queue. With `expectedContent` (the text the
   * edit started from) it saves only if the message still has it, and otherwise answers it as it is now.
   */
  editQueued(threadId: string, itemId: string, content: string, expectedContent?: string): Promise<QueueEditResult>
  /** Moves a queued message into the running turn. */
  steerQueued(threadId: string, itemId: string): Promise<void>
  contextUsage(threadId: string): Promise<ContextUsage | undefined>
  /** Dictation and read aloud with the computer's speech models; absent when unavailable. */
  readonly speech?: ComputerSpeech
  /** The owner's personal bots on this computer. */
  readonly bots?: ComputerBots
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
  /** Whether this phone still has to join the account's computers, read from Mousse ID. */
  joinPlan(): Promise<JoinPlan>
  /** Lets the phone join on its own again after the user's computers removed it. */
  allowRejoin(): Promise<void>
  /** Accepts the text of a `mousse://net/join?...` QR code. */
  enrollFromQr(payload: string, onProgress: (progress: EnrollmentProgress) => void): Promise<void>
  openComputer(nodeId: string): Promise<ComputerSession>
}
