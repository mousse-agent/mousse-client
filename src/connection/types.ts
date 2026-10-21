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
  listProjects(): Promise<Project[]>
  listThreads(filter?: { projectId?: string; query?: string }): Promise<ThreadSummary[]>
  createThread(input: { projectId: string; title?: string }): Promise<ThreadSummary>
  /** Calls onItems with the full item list on open and after every change. Returns an unsubscribe. */
  openThread(threadId: string, onItems: (items: ChatItem[]) => void): Promise<() => void>
  send(threadId: string, text: string): Promise<void>
  abort(threadId: string): Promise<void>
  isTurnActive(threadId: string): Promise<boolean>
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
