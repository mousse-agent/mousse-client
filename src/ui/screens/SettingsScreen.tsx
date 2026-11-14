import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Computer } from '../../connection/types'
import { accountEmail, deviceUsage, useAccount, useAutoJoin, useComputers, useConnection } from '../hooks/connection'
import { useAppearance } from '../hooks/useAppearance'
import { useRouter } from '../state/router'
import { ACCENT_COLORS, type ThemePreference } from '../theme/appearance'
import { Bot, Check, ChevronLeft, ChevronRight, Info, LogOut, Monitor, Palette, QrCode, Smartphone, User, type IconComponent } from '../components/icons'
import { Button, IconButton, MousseLogo, Notice, Segmented, StatusDot, TopBar } from '../components/primitives'
import { AddPhoneSheet } from './AddPhoneSheet'
import { faceGuardTripped, faceMode, setFaceMode, subscribeFaceGuard, type FaceMode } from '../bots/face/faceGuard'

/** 3D bot faces on or off. The app turns them off by itself when they stopped it last time. */
function BotFacesSection() {
  const mode = useSyncExternalStore(subscribeFaceGuard, faceMode, faceMode)
  const tripped = useSyncExternalStore(subscribeFaceGuard, faceGuardTripped, faceGuardTripped)
  return (
    <SettingsGroup title="Bots" icon={Bot}>
      <SettingsRow
        title="Bot faces"
        description={tripped
          ? 'Turned off because the 3D faces stopped the app on this phone. Bots show their last 3D picture instead.'
          : 'Off shows each bot’s last 3D picture and uses less of the phone.'}
      >
        <Segmented<FaceMode>
          label="Bot faces"
          value={mode}
          onChange={(next) => void setFaceMode(next)}
          options={[{ value: 'live', label: '3D' }, { value: 'still', label: 'Off' }]}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** Online, or when the device was last seen. */
export function lastSeen(device: Computer, now = Date.now()): string {
  if (device.online) return 'Online'
  if (!device.lastSeenAt) return 'Offline'
  const days = Math.floor((now - device.lastSeenAt) / 86_400_000)
  if (days < 1) return 'Offline · seen today'
  if (days === 1) return 'Offline · seen yesterday'
  return `Offline · seen ${days} days ago`
}

/**
 * Settings, laid out like the desktop's settings pages (mousse/src/renderer/styles/settings.css): a
 * heading per group, its rows on one subtle surface (title left, one control right, hairlines between),
 * buttons outside the surface, and the rarely needed rows behind one Advanced fold at the end.
 */
function SettingsGroup({ title, icon: Icon, label, children, after }: { title: string; icon?: IconComponent; label?: string; children?: ReactNode; after?: ReactNode }) {
  const headingId = useId()
  return (
    <section className="m-set-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="m-set-group__title">{Icon && <Icon size={16} strokeWidth={1.8} aria-hidden="true" />}{title}</h2>
      {children && <div className="m-set-rows" aria-label={label}>{children}</div>}
      {after && <div className="m-set-after">{after}</div>}
    </section>
  )
}

/** One setting: a title (and a quieter line under it) on the left, one control on the right, or full width under the title. */
function SettingsRow({ title, description, leading, control, children, testId }: {
  title: ReactNode
  description?: ReactNode
  leading?: ReactNode
  control?: ReactNode
  children?: ReactNode
  testId?: string
}) {
  return (
    <div className={`m-set-row${children ? ' m-set-row--stack' : ''}`}>
      <div className="m-set-row__main">
        {leading && <span className="m-set-row__leading">{leading}</span>}
        <span className="m-set-row__text">
          <span className="m-set-row__title">{title}</span>
          {description && <span className="m-set-row__desc" data-testid={testId}>{description}</span>}
        </span>
        {control && <span className="m-set-row__control">{control}</span>}
      </div>
      {children}
    </div>
  )
}

/** The account's computers and phones, with the QR code as the way in when joining on its own cannot work. */
function DevicesSection({ computers }: { computers: ReturnType<typeof useComputers> }) {
  const join = useAutoJoin()
  const [scanning, setScanning] = useState(false)
  const [rejoining, setRejoining] = useState(false)
  const list = computers.data ?? []
  const desktops = list.filter((device) => device.kind === 'computer')
  const phones = list.filter((device) => device.kind === 'phone')
  const row = (device: Computer) => {
    const Icon = device.kind === 'phone' ? Smartphone : Monitor
    const detail = device.kind === 'computer' && !device.enrolled ? `${lastSeen(device)} · not added` : lastSeen(device)
    return (
      <SettingsRow
        key={device.nodeId}
        leading={<span className="m-row__icon"><Icon /><StatusDot state={device.online ? 'online' : 'offline'} /></span>}
        title={device.name}
        description={detail}
      />
    )
  }
  return (
    <SettingsGroup
      title="Devices"
      icon={Monitor}
      after={
        <>
          {computers.error && !computers.data && <Notice>{computers.error}</Notice>}
          {computers.data && !list.length && <p className="m-muted">No devices yet. Open Mousse on your computer and sign in with the same Mousse ID.</p>}
          {join.state === 'removed' && (
            <Button block busy={rejoining} onClick={() => {
              setRejoining(true)
              void join.rejoin().finally(() => setRejoining(false))
            }}>Add this phone again</Button>
          )}
          <Button block icon={<QrCode />} onClick={() => setScanning(true)}>Add with a QR code</Button>
          <AddPhoneSheet
            open={scanning}
            onClose={() => setScanning(false)}
            onAdded={() => {
              setScanning(false)
              computers.reload()
            }}
          />
        </>
      }
    >
      {list.length > 0 && (
        <>
          {desktops.length > 0 && <div className="m-set-subrows" role="group" aria-label="Computers">{desktops.map(row)}</div>}
          {phones.length > 0 && <div className="m-set-subrows" role="group" aria-label="Phones">{phones.map(row)}</div>}
        </>
      )}
    </SettingsGroup>
  )
}

export function SettingsScreen() {
  const connection = useConnection()
  const account = useAccount()
  const router = useRouter()
  const { appearance, setAppearance } = useAppearance()
  const [advanced, setAdvanced] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const signedIn = account.status === 'signed-in' ? account : undefined
  const email = accountEmail(account)
  const devices = useComputers()
  const usage = deviceUsage(account, devices.data?.length)
  const advancedId = useId()

  async function signOut() {
    setSigningOut(true)
    try {
      await connection.signOut()
      router.reset()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <main className="m-screen">
      <TopBar leading={<IconButton label="Back" onClick={router.pop}><ChevronLeft size={22} /></IconButton>} title="Settings" />
      <div className="m-scroll"><div className="m-content m-settings">
        <SettingsGroup
          title="Account"
          icon={User}
          after={<Button variant="danger" block icon={<LogOut />} busy={signingOut} onClick={() => void signOut()}>Sign out</Button>}
        >
          <SettingsRow title="Mousse ID" description={signedIn ? email ?? 'Signed in, no email on file' : 'Signed out'} />
          {usage && <SettingsRow title="Device limit" description={`${usage.used} of ${usage.limit} devices`} testId="device-usage" />}
        </SettingsGroup>

        {signedIn && <DevicesSection computers={devices} />}

        <SettingsGroup title="Colors" icon={Palette}>
          <SettingsRow title="Color theme">
            <Segmented<ThemePreference>
              label="Color theme"
              value={appearance.theme}
              onChange={(theme) => setAppearance({ theme })}
              options={[{ value: 'mousse-dark', label: 'Mousse dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
            />
          </SettingsRow>
          <SettingsRow title="Accent color">
            <div className="m-swatches" role="radiogroup" aria-label="Accent color">
              {ACCENT_COLORS.map((color) => {
                const selected = color.value.toLowerCase() === appearance.accentColor.toLowerCase()
                return (
                  <button
                    key={color.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={color.label}
                    title={color.label}
                    className="m-swatch"
                    style={{ ['--swatch' as string]: color.value }}
                    onClick={() => setAppearance({ accentColor: color.value })}
                  >
                    {selected && <Check size={14} strokeWidth={2.4} />}
                  </button>
                )
              })}
            </div>
          </SettingsRow>
        </SettingsGroup>

        <BotFacesSection />

        <SettingsGroup title="About" icon={Info}>
          <SettingsRow leading={<MousseLogo size={22} />} title="Mousse for phones" control={<span className="m-set-row__value">Version {__APP_VERSION__}</span>} />
        </SettingsGroup>

        <section className="m-set-fold">
          <button type="button" className="m-set-fold__toggle" aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced((value) => !value)}>
            <span>Advanced</span>
            <ChevronRight size={16} className="m-set-fold__chevron" aria-hidden="true" />
          </button>
          {advanced && (
            <div id={advancedId} className="m-set-rows">
              <SettingsRow title="Mousse ID server" description={<span className="font-mono">{signedIn?.idOrigin || 'Not signed in'}</span>} />
              <SettingsRow title="Account id" description={<span className="font-mono">{signedIn?.account.id ?? '—'}</span>} />
            </div>
          )}
        </section>
      </div></div>
    </main>
  )
}
