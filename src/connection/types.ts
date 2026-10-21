// The boundary between the phone UI and the connection layer. The UI only
// talks to MousseConnection; the Net and Mousse ID implementation lives in src/net and
// src/mousseId. Keep this file small and stable: both sides depend on it.

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

export interface ChatItem {
  id: string
  role: ChatRole
  text: string
  createdAt: number
  status?: 'streaming' | 'done' | 'error'
  toolName?: string
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
  /** Calls onItems with the full item list on open and after every change. Returns an unsubscribe. */
  openThread(threadId: string, onItems: (items: ChatItem[]) => void): Promise<() => void>
  send(threadId: string, text: string): Promise<void>
  abort(threadId: string): Promise<void>
  isTurnActive(threadId: string): Promise<boolean>
  /**
   * Follows the computer's projects, threads, chats and their run status. Calls `lists` with the
   * current lists right away when known, then after every change. Returns an unsubscribe.
   */
  watchLists(handlers: ListsHandlers): () => void
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
