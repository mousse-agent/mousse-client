import { useCallback, useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  FolderGit2,
  GitBranch,
  Laptop,
  ListTodo,
  LogOut,
  Menu,
  MessageSquareText,
  MonitorOff,
  Network,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X
} from 'lucide-react'
import { connectionManager } from './connectionManager'
import { parseQr } from './connectionQr'
import { loginHosted, logoutHosted, openHostedSignup } from './hostedAuth'
import type {
  AppSnapshot,
  ConnectionMode,
  HostedSession,
  MachineRecord,
  Message,
  ParsedQr,
  PendingQuestion,
  QrPayloadV2
} from './types'

type View = 'chat' | 'agents' | 'files' | 'terminal' | 'jobs' | 'channels' | 'settings'

const emptySnapshot: AppSnapshot = {
  projects: [],
  threads: [],
  messages: {},
  questions: {},
  agents: [],
  tasks: [],
  workspace: {},
  jobs: [],
  channels: {},
  settings: {},
  mcp: [],
  skills: []
}

const nav: { id: View; label: string; icon: typeof MessageSquareText }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'files', label: 'Files & Git', icon: FolderGit2 },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'jobs', label: 'Jobs', icon: Clock3 },
  { id: 'channels', label: 'Channels', icon: Network },
  { id: 'settings', label: 'Settings', icon: Settings }
]

const asArray = <T,>(value: unknown, key?: string): T[] =>
  Array.isArray(value)
    ? (value as T[])
    : key && value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[key])
      ? ((value as Record<string, unknown>)[key] as T[])
      : []

export function App() {
  const [, setTick] = useState(0)
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot)
  const [view, setView] = useState<View>('chat')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [showMachineModal, setShowMachineModal] = useState(false)
  const [pendingTrust, setPendingTrust] = useState<{ parsed: ParsedQr; raw: string } | null>(null)

  useEffect(() => {
    return connectionManager.subscribe(() => setTick(t => t + 1))
  }, [])

  useEffect(() => {
    void connectionManager.initialize()
  }, [])

  const mode = connectionManager.getMode()
  const session = connectionManager.getSession()
  const machines = connectionManager.getMachines()
  const activeMachine = connectionManager.getActiveMachine()
  const status = connectionManager.getStatus()
  const health = connectionManager.getHealth()
  const outcomeUnknownOps = connectionManager.getOutcomeUnknownOperations()

  const call = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}, mutate = false) => {
      return connectionManager.request<T>(method, params, mutate)
    },
    []
  )

  const reload = useCallback(async () => {
    if (!activeMachine) return
    try {
      const [projects, threads, agents, tasks, workspace, jobs, channels, settings, mcp, skills] =
        await Promise.all([
          call<unknown>('projects.list').catch(() => []),
          call<unknown>('threads.list').catch(() => []),
          threadId ? call<unknown>('agents.list', { threadId }).catch(() => []) : Promise.resolve([]),
          threadId ? call<unknown>('tasks.list', { threadId }).catch(() => []) : Promise.resolve([]),
          threadId ? call<unknown>('workspace.getStatus', { threadId }).catch(() => ({})) : Promise.resolve({}),
          call<unknown>('scheduled.list').catch(() => []),
          call<unknown>('channels.getSnapshot').catch(() => ({})),
          call<unknown>('settings.get').catch(() => ({})),
          call<unknown>('mcp.listServers').catch(() => []),
          call<unknown>('skills.list').catch(() => [])
        ])
      const workspaceRecord = workspace as Record<string, unknown>
      const settingsRecord = settings as Record<string, unknown>
      setSnapshot(s => ({
        ...s,
        projects: asArray(projects, 'projects'),
        threads: asArray(threads, 'threads'),
        agents: asArray(agents, 'agents'),
        tasks: asArray(tasks, 'tasks'),
        workspace: (workspaceRecord.status ?? workspaceRecord) as Record<string, unknown>,
        jobs: asArray(jobs, 'jobs'),
        channels: channels as Record<string, unknown>,
        settings: (settingsRecord.settings ?? settingsRecord) as Record<string, unknown>,
        mcp: asArray(mcp, 'servers'),
        skills: asArray(skills, 'skills')
      }))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not refresh server data.')
    }
  }, [call, threadId, activeMachine])

  const loadThread = useCallback(
    async (id: string) => {
      try {
        const result = await call<Record<string, unknown>>('thread.snapshot', { threadId: id })
        const messages = asArray<Message>(result.messages)
        const questions = asArray<PendingQuestion>(result.pendingQuestions)
        setSnapshot(s => ({
          ...s,
          messages: { ...s.messages, [id]: messages },
          questions: { ...s.questions, [id]: questions }
        }))
        setThreadId(id)
        setView('chat')
        setDrawer(false)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not load thread.')
      }
    },
    [call]
  )

  useEffect(() => {
    if (!activeMachine || status !== 'live') return
    void reload()
  }, [activeMachine?.id, status, reload])

  useEffect(() => {
    const unEvent = connectionManager.onEvent(ev => {
      applyEvent(ev, setSnapshot, reload)
    })
    const unSnap = connectionManager.onSnapshotRequired(() => {
      void reload()
    })
    return () => {
      unEvent()
      unSnap()
    }
  }, [reload])

  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === 'visible') {
        void reload()
      }
    }
    document.addEventListener('visibilitychange', visibility)
    const resume = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void reload()
    })
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      resume.then(x => x.remove())
    }
  }, [reload])

  const handlePairQr = async (rawQr: string) => {
    try {
      const parsed = await parseQr(rawQr)
      if (parsed.version === 2) {
        setPendingTrust({ parsed, raw: rawQr })
      } else {
        await connectionManager.pairLegacy(parsed.baseUrl)
        void reload()
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Invalid QR code.')
    }
  }

  const confirmTrustAndPair = async () => {
    if (!pendingTrust || pendingTrust.parsed.version !== 2) return
    const { payload, fingerprint, mmsFingerprint } = pendingTrust.parsed
    setPendingTrust(null)
    try {
      await connectionManager.pairQrV2(payload, fingerprint, mmsFingerprint)
      void reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Pairing failed.')
    }
  }

  const connected = Boolean(activeMachine && status !== 'offline' && status !== 'revoked')

  return (
    <main className="shell">
      {!activeMachine || (!connected && status !== 'connecting' && status !== 'reconnecting' && status !== 'approval_pending') ? (
        <OnboardingScreen
          mode={mode}
          session={session}
          onSetMode={m => connectionManager.setMode(m)}
          onScanQr={handlePairQr}
          onSetNotice={setNotice}
        />
      ) : status === 'approval_pending' ? (
        <ApprovalWaitingView
          machine={activeMachine}
          onCancel={() => void connectionManager.forgetMachine(activeMachine.id)}
        />
      ) : (
        <>
          <header className="topbar">
            <button
              className="icon-button mobile-only"
              onClick={() => setDrawer(true)}
              aria-label="Open navigation"
            >
              <Menu />
            </button>
            <img src="/mousse-logo.svg" className="logo" alt="Mousse" />
            <button
              className="machine-selector-btn"
              onClick={() => setShowMachineModal(true)}
              aria-label="Switch machine"
            >
              <Laptop style={{ width: 16, height: 16 }} />
              <span>{activeMachine.name}</span>
              <span className={`machine-badge ${activeMachine.mode}`}>{activeMachine.mode}</span>
              {health.latencyMs !== undefined && health.latencyMs > 0 && (
                <span className="latency-tag">{health.latencyMs}ms</span>
              )}
            </button>
            <span className={`connection ${status}`}>
              <CircleDot />
              {status === 'live' ? 'Live' : status}
            </span>
            <button className="icon-button" onClick={() => void reload()} aria-label="Refresh server">
              <RefreshCw />
            </button>
          </header>

          <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Mousse navigation">
            <div className="side-head">
              <span>Workspace</span>
              <button
                className="icon-button mobile-only"
                onClick={() => setDrawer(false)}
                aria-label="Close navigation"
              >
                <X />
              </button>
            </div>
            <button
              className="new-thread"
              onClick={() => void createThread(call, setSnapshot, setThreadId, setView, setNotice, projectId)}
            >
              <Plus /> New thread
            </button>
            <section>
              <p className="section-title">Projects</p>
              {snapshot.projects.map(project => (
                <button
                  className={`project ${project.id === projectId ? 'selected' : ''}`}
                  key={project.id}
                  onClick={() => {
                    setProjectId(project.id)
                    setView('chat')
                    setDrawer(false)
                  }}
                >
                  <FolderGit2 />
                  {project.name}
                </button>
              )) || <p className="muted">No projects yet</p>}
            </section>
            <section className="threads">
              <p className="section-title">Threads</p>
              {snapshot.threads
                .filter(t => !t.settledAt)
                .map(thread => (
                  <button
                    key={thread.id}
                    onClick={() => void loadThread(thread.id)}
                    className={`thread ${thread.id === threadId ? 'selected' : ''}`}
                  >
                    <MessageSquareText />
                    <span>{thread.title || 'Untitled thread'}</span>
                    {thread.active && <i aria-label="Active" />}
                  </button>
                ))}
            </section>
            <nav>
              {nav.map(item => (
                <button
                  key={item.id}
                  className={view === item.id ? 'selected' : ''}
                  onClick={() => {
                    setView(item.id)
                    setDrawer(false)
                  }}
                >
                  <item.icon />
                  {item.label}
                </button>
              ))}
            </nav>
            <button
              className="disconnect"
              onClick={() => void connectionManager.disconnect()}
            >
              <MonitorOff /> Disconnect
            </button>
          </aside>
          <div className="overlay" onClick={() => setDrawer(false)} />

          <section className="content">
            {status === 'revoked' && (
              <div role="alert" className="revoked-banner">
                <div>
                  <strong>Pairing Revoked</strong>
                  <p style={{ margin: '4px 0 0', fontSize: '0.8rem' }}>
                    This computer pairing has been revoked. Re-scan a fresh QR code from your computer.
                  </p>
                </div>
                <button
                  className="danger"
                  onClick={() => void connectionManager.forgetMachine(activeMachine.id)}
                >
                  Forget
                </button>
              </div>
            )}

            {outcomeUnknownOps.length > 0 && (
              <div role="alert" className="outcome-banner">
                <strong>Mutation Outcome Ambiguous</strong>
                <p style={{ margin: 0, fontSize: '0.8rem' }}>
                  A mutating operation was interrupted by connection drop. It may or may not have completed on your computer.
                </p>
                <div className="outcome-actions">
                  <button onClick={() => void reload()}>Reload State</button>
                  {outcomeUnknownOps.map(op => (
                    <button
                      key={op.requestId}
                      onClick={() => connectionManager.dismissOutcomeUnknown(op.requestId)}
                    >
                      Dismiss {op.method}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {notice && (
              <div role="alert" className="notice">
                <AlertTriangle />
                {notice}
                <button onClick={() => setNotice(null)} aria-label="Dismiss">
                  <X />
                </button>
              </div>
            )}

            <ViewContent
              view={view}
              snapshot={snapshot}
              threadId={threadId}
              projectId={projectId}
              admin={false}
              call={call}
              setSnapshot={setSnapshot}
              setNotice={setNotice}
              onSelectThread={loadThread}
              machines={machines}
              activeMachine={activeMachine}
              session={session}
            />
          </section>

          <nav className="bottom-nav" aria-label="Mobile navigation">
            {nav.slice(0, 5).map(item => (
              <button
                className={view === item.id ? 'selected' : ''}
                onClick={() => setView(item.id)}
                key={item.id}
              >
                <item.icon />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </>
      )}

      {pendingTrust && (
        <TrustConfirmationModal
          qr={pendingTrust.parsed as any}
          onConfirm={confirmTrustAndPair}
          onCancel={() => setPendingTrust(null)}
        />
      )}

      {showMachineModal && (
        <MachineSelectorModal
          machines={machines}
          activeId={activeMachine?.id || null}
          onSelect={id => {
            setShowMachineModal(false)
            void connectionManager.switchMachine(id)
          }}
          onPairNew={() => {
            setShowMachineModal(false)
            void connectionManager.disconnect()
          }}
          onClose={() => setShowMachineModal(false)}
        />
      )}
    </main>
  )
}

function OnboardingScreen({
  mode,
  session,
  onSetMode,
  onScanQr,
  onSetNotice
}: {
  mode: ConnectionMode
  session: HostedSession | null
  onSetMode: (mode: ConnectionMode) => void
  onScanQr: (qr: string) => Promise<void>
  onSetNotice: (n: string) => void
}) {
  const [dashboardUrl, setDashboardUrl] = useState('https://plus.mousse.example')
  const [serverUrl, setServerUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const scan = async () => {
    setBusy(true)
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: 'Scan the QR code shown by Mousse Desktop or CLI'
      })
      await onScanQr(result.ScanResult)
    } catch (e) {
      onSetNotice(e instanceof Error ? e.message : 'QR scan was cancelled or failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleLogin = async () => {
    setBusy(true)
    try {
      await loginHosted(dashboardUrl)
    } catch (e) {
      onSetNotice(e instanceof Error ? e.message : 'Login failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleSignup = async () => {
    try {
      await openHostedSignup(dashboardUrl)
    } catch (e) {
      onSetNotice(e instanceof Error ? e.message : 'Failed to open signup.')
    }
  }

  const handleConnectLegacy = async () => {
    if (!serverUrl) return
    setBusy(true)
    try {
      await connectionManager.pairLegacy(serverUrl)
    } catch (e) {
      onSetNotice(e instanceof Error ? e.message : 'Direct connection failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="onboarding">
      <div className="onboard-card">
        <img src="/mousse-logo.svg" className="onboard-logo" alt="Mousse" />
        <p className="eyebrow">MOUSSE MOBILE</p>
        <h1>Your Mousse, wherever you are.</h1>

        <div className="mode-tabs" role="tablist">
          <button
            className={`mode-tab ${mode === 'hosted' ? 'active' : ''}`}
            onClick={() => onSetMode('hosted')}
          >
            Mousse Plus
          </button>
          <button
            className={`mode-tab ${mode === 'self-hosted' ? 'active' : ''}`}
            onClick={() => onSetMode('self-hosted')}
          >
            Self-Hosted
          </button>
          <button
            className={`mode-tab ${mode === 'legacy' ? 'active' : ''}`}
            onClick={() => onSetMode('legacy')}
          >
            Direct / Legacy
          </button>
        </div>

        {mode === 'hosted' && (
          <>
            {!session ? (
              <>
                <p className="muted">
                  Hosted Mousse Plus mode connects to your computer securely through encrypted relay. Sign in to your account to pair.
                </p>
                <label htmlFor="dash-url">Plus Dashboard URL</label>
                <input
                  id="dash-url"
                  value={dashboardUrl}
                  onChange={e => setDashboardUrl(e.target.value)}
                  placeholder="https://plus.mousse.example"
                />
                <button className="primary" disabled={busy} onClick={() => void handleLogin()}>
                  {busy ? 'Opening browser…' : 'Sign in with Mousse Plus'}
                </button>
                <button className="text-button" onClick={() => void handleSignup()}>
                  Don't have an account? Sign up
                </button>
              </>
            ) : (
              <>
                <div className="account-card">
                  <div className="account-info">
                    <strong>{session.email || 'Mousse Plus Member'}</strong>
                    <span>Account ID: {session.account_id.slice(0, 12)}…</span>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => void logoutHosted(session)}
                    aria-label="Sign out"
                  >
                    <LogOut />
                  </button>
                </div>
                <p className="muted">
                  Point your phone at the pairing QR code displayed by Mousse Desktop or CLI.
                </p>
                <button className="primary scan-qr" disabled={busy} onClick={() => void scan()}>
                  <QrCode />
                  {busy ? 'Opening scanner…' : 'Scan pairing QR'}
                </button>
              </>
            )}
          </>
        )}

        {mode === 'self-hosted' && (
          <>
            <p className="muted">
              Connect to your private Mousse Control Server without an account. Possession of the pairing QR authorizes device trust.
            </p>
            <button className="primary scan-qr" disabled={busy} onClick={() => void scan()}>
              <QrCode />
              {busy ? 'Opening scanner…' : 'Scan self-hosted QR'}
            </button>
          </>
        )}

        {mode === 'legacy' && (
          <>
            <p className="muted">
              Connect directly to an MMS server over local HTTP/HTTPS (Protocol 1.0).
            </p>
            <button className="primary scan-qr" disabled={busy} onClick={() => void scan()}>
              <QrCode />
              {busy ? 'Opening scanner…' : 'Scan legacy connection QR'}
            </button>
            <div className="pairing-divider">
              <span>or enter address</span>
            </div>
            <label htmlFor="server">Server URL</label>
            <input
              id="server"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="https://mousse.example.test:28478"
            />
            <button
              className="primary"
              disabled={busy || !serverUrl}
              onClick={() => void handleConnectLegacy()}
            >
              {busy ? 'Connecting…' : 'Connect direct'}
            </button>
          </>
        )}
      </div>
    </section>
  )
}

function ApprovalWaitingView({
  machine,
  onCancel
}: {
  machine: MachineRecord
  onCancel: () => void
}) {
  return (
    <section className="onboarding">
      <div className="approval-view">
        <div className="pulse-spinner" />
        <h2>Waiting for local approval</h2>
        <p className="muted">
          A pairing request has been sent to <strong>{machine.name}</strong>.
          <br />
          Please approve this mobile device on your computer.
        </p>
        <div className="fingerprint-box">MMS ID: {machine.mmsDeviceId}</div>
        <button className="danger" onClick={onCancel}>
          Cancel pairing
        </button>
      </div>
    </section>
  )
}

function TrustConfirmationModal({
  qr,
  onConfirm,
  onCancel
}: {
  qr: { payload: QrPayloadV2; fingerprint: string; mmsFingerprint: string }
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="trust-overlay" role="dialog" aria-modal="true">
      <div className="trust-card">
        <h2>
          <ShieldCheck style={{ color: '#bbf16a' }} />
          Confirm Computer Trust
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
          Verify the cryptographic identity of the computer you are pairing with:
        </p>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#9eaaa1' }}>Control Server</label>
          <div style={{ fontWeight: 600 }}>{qr.payload.controlOrigin}</div>
        </div>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#9eaaa1' }}>Server Fingerprint</label>
          <div className="fingerprint-box">{qr.fingerprint}</div>
        </div>
        <div>
          <label style={{ fontSize: '0.75rem', color: '#9eaaa1' }}>Computer Device Fingerprint</label>
          <div className="fingerprint-box">{qr.mmsFingerprint}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button className="primary" style={{ flex: 1 }} onClick={onConfirm}>
            Trust & Connect
          </button>
          <button className="text-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function MachineSelectorModal({
  machines,
  activeId,
  onSelect,
  onPairNew,
  onClose
}: {
  machines: MachineRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onPairNew: () => void
  onClose: () => void
}) {
  return (
    <div className="trust-overlay" role="dialog" aria-modal="true">
      <div className="trust-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Paired Computers</h2>
          <button className="icon-button" onClick={onClose}>
            <X />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {machines.map(m => (
            <button
              key={m.id}
              onClick={() => onSelect(m.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                background: m.id === activeId ? '#1f3025' : '#17221c',
                border: `1px solid ${m.id === activeId ? '#3d5c48' : '#26352c'}`,
                borderRadius: 8
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', gap: 2 }}>
                <strong style={{ color: '#e9f0e8' }}>{m.name}</strong>
                <span style={{ fontSize: '0.75rem', color: '#9eaaa1' }}>
                  {m.mode} · {m.status}
                </span>
              </div>
              {m.id === activeId && <Check style={{ color: '#bbf16a', width: 18, height: 18 }} />}
            </button>
          ))}
        </div>
        <button className="primary" onClick={onPairNew} style={{ marginTop: 8 }}>
          <Plus /> Pair Another Computer
        </button>
      </div>
    </div>
  )
}

function ViewContent({
  view,
  snapshot,
  threadId,
  projectId,
  admin,
  call,
  setSnapshot,
  setNotice,
  onSelectThread,
  machines,
  activeMachine,
  session
}: {
  view: View
  snapshot: AppSnapshot
  threadId: string | null
  projectId: string | null
  admin: boolean
  call: <T>(method: string, params?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setSnapshot: React.Dispatch<React.SetStateAction<AppSnapshot>>
  setNotice: (x: string) => void
  onSelectThread: (id: string) => void
  machines: MachineRecord[]
  activeMachine: MachineRecord
  session: HostedSession | null
}) {
  if (view === 'chat') {
    return (
      <Chat
        snapshot={snapshot}
        threadId={threadId}
        call={call}
        setSnapshot={setSnapshot}
        setNotice={setNotice}
        onSelectThread={onSelectThread}
      />
    )
  }
  if (view === 'agents') {
    return <Agents snapshot={snapshot} threadId={threadId} call={call} setNotice={setNotice} />
  }
  if (view === 'files') {
    return <FilesGit snapshot={snapshot} projectId={projectId} call={call} setNotice={setNotice} />
  }
  if (view === 'terminal') {
    return <Terminal threadId={threadId} call={call} setNotice={setNotice} />
  }
  if (view === 'jobs') {
    return <Jobs snapshot={snapshot} call={call} setNotice={setNotice} />
  }
  if (view === 'channels') {
    return <Channels snapshot={snapshot} admin={admin} call={call} setNotice={setNotice} />
  }
  return (
    <SettingsPanel
      snapshot={snapshot}
      call={call}
      setNotice={setNotice}
      machines={machines}
      activeMachine={activeMachine}
      session={session}
    />
  )
}

function Chat({
  snapshot,
  threadId,
  call,
  setSnapshot,
  setNotice,
  onSelectThread
}: {
  snapshot: AppSnapshot
  threadId: string | null
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setSnapshot: React.Dispatch<React.SetStateAction<AppSnapshot>>
  setNotice: (x: string) => void
  onSelectThread: (id: string) => void
}) {
  const [text, setText] = useState('')
  const active = snapshot.threads.find(x => x.id === threadId)
  const messages = threadId ? snapshot.messages[threadId] ?? [] : []

  const send = async () => {
    if (!threadId || !text.trim()) return
    const content = text.trim()
    setText('')
    const temp: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString()
    }
    setSnapshot(s => ({
      ...s,
      messages: { ...s.messages, [threadId]: [...(s.messages[threadId] ?? []), temp] }
    }))
    try {
      await call('orchestrator.send', { threadId, content, source: 'mobile' }, true)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Message could not be sent.')
      setText(content)
    }
  }

  if (!threadId) {
    return (
      <Empty
        title="Choose a thread"
        text="Select a conversation from your workspace, or start a new thread."
        action="Open first thread"
        onAction={() => snapshot.threads[0] && onSelectThread(snapshot.threads[0].id)}
      />
    )
  }

  return (
    <div className="chat-view">
      <header className="view-head">
        <div>
          <p className="eyebrow">THREAD</p>
          <h2>{active?.title ?? 'Conversation'}</h2>
        </div>
      </header>
      <div className="messages" aria-live="polite">
        {messages.length ? (
          messages.map(message => (
            <article className={`message ${message.role}`} key={message.id}>
              <span className="message-role">
                {message.role === 'assistant' ? 'Mousse' : message.role}
              </span>
              <p>{message.content}</p>
              {message.toolCalls?.map(tool => (
                <span className="tool" key={tool.name}>
                  <Code2 />
                  {tool.name} · {tool.status}
                </span>
              ))}
            </article>
          ))
        ) : (
          <p className="muted">No messages loaded. Send a prompt to begin.</p>
        )}
      </div>
      <QuestionQueue
        threadId={threadId}
        questions={snapshot.questions[threadId] ?? []}
        call={call}
        setNotice={setNotice}
      />
      <div className="composer">
        <textarea
          aria-label="Message Mousse"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Message Mousse…"
          rows={2}
        />
        <div>
          <span>Enter to send · Shift+Enter for newline</span>
          <button
            className="primary round"
            onClick={() => void send()}
            disabled={!text.trim()}
            aria-label="Send message"
          >
            <Send />
          </button>
        </div>
      </div>
    </div>
  )
}

function QuestionQueue({
  threadId,
  questions,
  call,
  setNotice
}: {
  threadId: string
  questions: PendingQuestion[]
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
}) {
  const [instruction, setInstruction] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const pending = questions[0]

  const submit = () => {
    if (!pending) return
    const complete = pending.questions.every(question => answers[question.id]?.trim())
    if (!complete) return setNotice('Answer every pending question.')
    void guarded(call('orchestrator.answerQuestions', { requestId: pending.requestId, answers }, true), setNotice)
  }

  return (
    <div className="question">
      <button onClick={() => setOpen(!open)}>
        <ListTodo />
        Agent questions and queue
        <ChevronRight className={open ? 'rotate' : ''} />
      </button>
      {open && (
        <div>
          {pending ? (
            <>
              {pending.questions.map(question => (
                <label key={question.id}>
                  {question.prompt}
                  {question.options?.length ? (
                    <select
                      value={answers[question.id] ?? ''}
                      onChange={e =>
                        setAnswers(current => ({ ...current, [question.id]: e.target.value }))
                      }
                    >
                      <option value="">Choose an option</option>
                      {question.options.map(option => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={answers[question.id] ?? ''}
                      onChange={e =>
                        setAnswers(current => ({ ...current, [question.id]: e.target.value }))
                      }
                      placeholder="Your answer"
                    />
                  )}
                </label>
              ))}
              <button onClick={submit}>Answer</button>
            </>
          ) : (
            <p>No pending agent questions.</p>
          )}
          <div className="inline-form">
            <input
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder="Instruction"
            />
            <button
              onClick={() =>
                void guarded(
                  call('orchestrator.steer', { threadId, text: instruction, source: 'mobile' }, true),
                  setNotice
                )
              }
              disabled={!instruction}
            >
              Steer
            </button>
            <button
              className="danger"
              onClick={() => void guarded(call('orchestrator.abort', { threadId }, true), setNotice)}
            >
              Stop
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Agents({
  snapshot,
  threadId,
  call,
  setNotice
}: {
  snapshot: AppSnapshot
  threadId: string | null
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
}) {
  const [task, setTask] = useState('')
  const start = () => {
    if (!threadId) return setNotice('Select a thread before starting an agent.')
    void guarded(call('agents.spawn', { threadId, cliType: 'mousse', task }, true), setNotice)
  }
  const stop = (agentId: unknown) => {
    if (!threadId) return setNotice('Select the agent thread before stopping it.')
    void guarded(call('agents.stop', { threadId, agentId }, true), setNotice)
  }
  return (
    <div className="panel">
      <Header title="Agents & tasks" text="Monitor delegated work and keep the queue moving." />
      <div className="cards">
        {snapshot.agents.map((agent, i) => (
          <article className="card" key={String(agent.id ?? i)}>
            <Bot />
            <div>
              <strong>{String(agent.name ?? agent.id ?? 'Mousse agent')}</strong>
              <p>{String(agent.status ?? 'Idle')}</p>
            </div>
            <button onClick={() => stop(agent.id)}>Stop</button>
          </article>
        )) || <Empty title="No active agents" text="Agents launched from a thread appear here." />}
      </div>
      <h3>Tasks</h3>
      <List rows={snapshot.tasks} empty="No tasks reported by the server." />
      <div className="inline-form">
        <input
          value={task}
          onChange={e => setTask(e.target.value)}
          placeholder="Agent assignment"
        />
        <button className="primary" disabled={!task} onClick={start}>
          <Plus /> Start agent
        </button>
      </div>
    </div>
  )
}

function FilesGit({
  snapshot,
  projectId,
  call,
  setNotice
}: {
  snapshot: AppSnapshot
  projectId: string | null
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
}) {
  const [path, setPath] = useState('')
  const [content, setContent] = useState('')
  const selected = snapshot.projects.find(project => project.id === projectId)
  const read = async () => {
    if (!projectId) return setNotice('Select a project before reading files.')
    try {
      const result = await call<Record<string, unknown>>('files.read', { projectId, path })
      setContent(String(result.content ?? ''))
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Unable to read file.')
    }
  }
  const withProject = (method: string, params: Record<string, unknown> = {}, mutate = false) => {
    if (!projectId) return setNotice('Select a project before using Files & Git.')
    void guarded(call(method, { projectId, ...params }, mutate), setNotice)
  }
  return (
    <div className="panel">
      <Header title="Files & Git" text="Review workspace changes or edit a server file." />
      <div className="workspace-status">
        <GitBranch />
        <div>
          <strong>{selected?.name ?? 'Select a project'}</strong>
          <span>{String(snapshot.workspace.summary ?? 'Status supplied by Mousse')}</span>
        </div>
        <button onClick={() => withProject('git.status')}>Refresh</button>
      </div>
      <div className="inline-form">
        <input
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="Server-relative file path"
        />
        <button onClick={() => void read()} disabled={!path || !projectId}>
          Read
        </button>
        <button
          onClick={() => withProject('files.write', { path, content }, true)}
          disabled={!path || !projectId}
        >
          Save
        </button>
      </div>
      <textarea
        className="code-editor"
        value={content}
        onChange={e => setContent(e.target.value)}
        aria-label="File contents"
        placeholder="Choose a file to inspect"
      />
      <div className="action-row">
        <button onClick={() => withProject('git.diff')}>Diff</button>
        <button onClick={() => withProject('git.commit', { message: 'Mousse mobile update' }, true)}>
          Commit
        </button>
        <button onClick={() => withProject('git.push', {}, true)}>Push</button>
      </div>
    </div>
  )
}

function Terminal({
  threadId,
  call,
  setNotice
}: {
  threadId: string | null
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
}) {
  const [ptyId, setPtyId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [command, setCommand] = useState('')
  const [output, setOutput] = useState('')
  const start = async () => {
    if (!threadId || !agentId)
      return setNotice('Select a thread and enter its agent ID before opening a terminal.')
    try {
      const response = await call<Record<string, unknown>>('pty.create', { threadId, agentId }, true)
      setPtyId(String(response.ptyId ?? ''))
      setOutput('Terminal session created.\n')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Unable to create terminal.')
    }
  }
  const write = async () => {
    if (!ptyId || !command) return
    try {
      await call('pty.write', { ptyId, data: `${command}\n` }, true)
      const r = await call<Record<string, unknown>>('pty.scrollback', { ptyId })
      setOutput(String(r.scrollback ?? ''))
      setCommand('')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Terminal unavailable.')
    }
  }
  return (
    <div className="panel">
      <Header
        title="Terminal"
        text="A remote PTY is controlled by MMS and requires terminal permission."
      />
      <div className="terminal">
        <code>{output || 'No terminal session. Create one to begin.'}</code>
      </div>
      <div className="inline-form">
        <input
          value={agentId}
          onChange={e => setAgentId(e.target.value)}
          placeholder="Agent ID"
        />
        <button onClick={() => void start()}>
          <TerminalSquare /> New session
        </button>
        <input
          value={command}
          onChange={e => setCommand(e.target.value)}
          placeholder="Command"
          onKeyDown={e => e.key === 'Enter' && void write()}
        />
        <button onClick={() => void write()} disabled={!ptyId || !command}>
          Run
        </button>
      </div>
      {ptyId && (
        <button
          className="danger"
          onClick={() => void guarded(call('pty.kill', { ptyId }, true), setNotice)}
        >
          End session
        </button>
      )}
    </div>
  )
}

function Jobs({
  snapshot,
  call,
  setNotice
}: {
  snapshot: AppSnapshot
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
}) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [minutes, setMinutes] = useState('60')
  const create = () => {
    const interval = Number(minutes)
    if (!Number.isInteger(interval) || interval < 1)
      return setNotice('Repeat interval must be at least one minute.')
    void guarded(
      call(
        'scheduled.create',
        { input: { name, prompt, schedule: { kind: 'interval', minutes: interval } } },
        true
      ),
      setNotice
    )
  }
  return (
    <div className="panel">
      <Header title="Scheduled jobs" text="Schedule work on your Mousse server." />
      <div className="inline-form">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Job title"
        />
        <input
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Prompt"
        />
        <input
          value={minutes}
          onChange={e => setMinutes(e.target.value)}
          inputMode="numeric"
          placeholder="Repeat minutes"
        />
        <button className="primary" disabled={!name || !prompt} onClick={create}>
          <Plus /> Create
        </button>
      </div>
      <List
        rows={snapshot.jobs}
        empty="No scheduled jobs."
        action={row => (
          <>
            <button
              onClick={() => void guarded(call('scheduled.run', { id: row.id }, true), setNotice)}
            >
              Run
            </button>
            <button
              onClick={() => void guarded(call('scheduled.pause', { id: row.id }, true), setNotice)}
            >
              Pause
            </button>
          </>
        )}
      />
    </div>
  )
}

function Channels({
  snapshot,
  admin,
  call,
  setNotice
}: {
  snapshot: AppSnapshot
  admin: boolean
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
}) {
  const platforms = asArray<Record<string, unknown>>(snapshot.channels.platforms)
  return (
    <div className="panel">
      <Header title="Channels" text="Manage approved Mousse communication channels." />
      <div className="cards">
        {platforms.length ? (
          platforms.map((platform, i) => (
            <article className="card" key={String(platform.id ?? i)}>
              <Network />
              <div>
                <strong>{String(platform.name ?? platform.platform ?? 'Channel')}</strong>
                <p>{String(platform.status ?? 'Disconnected')}</p>
              </div>
              <button
                disabled={!admin}
                onClick={() =>
                  void guarded(call('channels.connect', { platform: platform.platform }, true), setNotice)
                }
              >
                Connect
              </button>
            </article>
          ))
        ) : (
          <Empty
            title="No channel integrations"
            text="Channel configuration is supplied by your Mousse server."
          />
        )}
      </div>
    </div>
  )
}

function SettingsPanel({
  snapshot,
  call,
  setNotice,
  machines,
  activeMachine,
  session
}: {
  snapshot: AppSnapshot
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>
  setNotice: (x: string) => void
  machines: MachineRecord[]
  activeMachine: MachineRecord
  session: HostedSession | null
}) {
  return (
    <div className="panel">
      <Header
        title="Settings & machines"
        text="Manage paired computers, account, and local preferences."
      />

      {session && (
        <>
          <h3>Mousse Plus Account</h3>
          <div className="account-card">
            <div className="account-info">
              <strong>{session.email || 'Plus Account'}</strong>
              <span>ID: {session.account_id}</span>
            </div>
            <button
              className="danger"
              onClick={() => void logoutHosted(session)}
            >
              Sign out
            </button>
          </div>
        </>
      )}

      <h3>Paired Computers ({machines.length})</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        {machines.map(m => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 16px',
              background: '#17221c',
              border: `1px solid ${m.id === activeMachine.id ? '#3d5c48' : '#26352c'}`,
              borderRadius: 10
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{m.name}</strong>
                <span className={`machine-badge ${m.mode}`}>{m.mode}</span>
                {m.id === activeMachine.id && (
                  <span style={{ fontSize: '0.75rem', color: '#bbf16a' }}>Active</span>
                )}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#9eaaa1', marginTop: 4 }}>
                Status: {m.status} · Origin: {m.controlOrigin}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {m.id !== activeMachine.id && (
                <button
                  onClick={() => void connectionManager.switchMachine(m.id)}
                  style={{ fontSize: '0.75rem', padding: '6px 10px', background: '#233329', borderRadius: 6 }}
                >
                  Switch
                </button>
              )}
              <button
                className="danger"
                onClick={() => void connectionManager.revokeMachine(m.id)}
                title="Revoke pairing"
                style={{ fontSize: '0.75rem', padding: '6px 10px', borderRadius: 6 }}
              >
                Revoke
              </button>
              <button
                onClick={() => void connectionManager.forgetMachine(m.id)}
                title="Forget computer"
                style={{ fontSize: '0.75rem', padding: '6px 10px', background: '#233329', borderRadius: 6 }}
              >
                <Trash2 style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <h3>Appearance & behavior</h3>
      <div className="settings-grid">
        {Object.entries(snapshot.settings)
          .slice(0, 8)
          .map(([key, value]) => (
            <label key={key}>
              {key}
              <input
                defaultValue={typeof value === 'string' ? value : JSON.stringify(value)}
                onBlur={e =>
                  void guarded(
                    call('settings.set', { patch: { [key]: e.target.value } }, true),
                    setNotice
                  )
                }
              />
            </label>
          ))}
      </div>
    </div>
  )
}

function Header({ title, text }: { title: string; text: string }) {
  return (
    <header className="view-head">
      <div>
        <p className="eyebrow">MOUSSE MOBILE</p>
        <h2>{title}</h2>
        <p className="muted">{text}</p>
      </div>
    </header>
  )
}

function List({
  rows,
  empty,
  action
}: {
  rows: Record<string, unknown>[]
  empty: string
  action?: (row: Record<string, unknown>) => React.ReactNode
}) {
  if (!rows.length) return <p className="muted">{empty}</p>
  return (
    <div className="list">
      {rows.map((row, i) => (
        <article key={String(row.id ?? i)}>
          <div>
            <strong>{String(row.name ?? row.title ?? row.id ?? 'Item')}</strong>
            <p>{String(row.status ?? row.description ?? '')}</p>
          </div>
          {action?.(row)}
        </article>
      ))}
    </div>
  )
}

function Empty({
  title,
  text,
  action,
  onAction
}: {
  title: string
  text: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="empty">
      <Code2 />
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button className="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  )
}

async function guarded(promise: Promise<unknown>, setNotice: (x: string) => void) {
  try {
    await promise
  } catch (e) {
    setNotice(e instanceof Error ? e.message : 'Action failed.')
  }
}

async function createThread(
  call: <T>(m: string, p?: Record<string, unknown>, mutate?: boolean) => Promise<T>,
  setSnapshot: React.Dispatch<React.SetStateAction<AppSnapshot>>,
  setThreadId: (x: string) => void,
  setView: (x: View) => void,
  setNotice: (x: string) => void,
  projectId: string | null
) {
  try {
    const result = await call<{ thread?: { id: string; title?: string } }>(
      'threads.create',
      { name: 'New mobile thread', ...(projectId ? { projectId } : {}) },
      true
    )
    if (result.thread) {
      const thread = {
        id: result.thread.id,
        title: result.thread.title ?? 'Untitled thread',
        ...(projectId ? { projectId } : {})
      }
      setSnapshot(s => ({ ...s, threads: [thread, ...s.threads] }))
      setThreadId(thread.id)
      setView('chat')
    }
  } catch (e) {
    setNotice(e instanceof Error ? e.message : 'Could not create thread.')
  }
}

function applyEvent(
  event: { event: string; payload: unknown },
  setSnapshot: React.Dispatch<React.SetStateAction<AppSnapshot>>,
  reload: () => Promise<void>
) {
  if (event.event === 'stream.reset') {
    void reload()
    return
  }
  const item = event.payload as {
    threadId?: string
    payload?: { message?: Message; thread?: { id: string } }
    message?: Message
  }
  const message = item?.payload?.message ?? item?.message
  if (message && item?.threadId) {
    setSnapshot(s => ({
      ...s,
      messages: {
        ...s.messages,
        [item.threadId!]: [...(s.messages[item.threadId!] ?? []).filter(x => x.id !== message.id), message]
      }
    }))
  }
  if (/^(projects|threads|agents|tasks|scheduled|channels|workspace)\./.test(event.event)) {
    void reload()
  }
}
