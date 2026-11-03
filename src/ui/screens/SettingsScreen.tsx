import { useState } from 'react'
import type { Computer } from '../../connection/types'
import { accountEmail, deviceUsage, useAccount, useAutoJoin, useComputers, useConnection } from '../hooks/connection'
import { useAppearance } from '../hooks/useAppearance'
import { useRouter } from '../state/router'
import { ACCENT_COLORS, type ThemePreference } from '../theme/appearance'
import { Check, ChevronDown, ChevronLeft, Info, LogOut, Monitor, QrCode, Smartphone, User } from '../components/icons'
import { Button, Card, IconButton, MousseLogo, Notice, SectionHeading, Segmented, StatusDot, TopBar } from '../components/primitives'
import { AddPhoneSheet } from './AddPhoneSheet'

/** Online, or when the device was last seen. */
export function lastSeen(device: Computer, now = Date.now()): string {
  if (device.online) return 'Online'
  if (!device.lastSeenAt) return 'Offline'
  const days = Math.floor((now - device.lastSeenAt) / 86_400_000)
  if (days < 1) return 'Offline · seen today'
  if (days === 1) return 'Offline · seen yesterday'
  return `Offline · seen ${days} days ago`
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
      <div key={device.nodeId} className="m-row m-row--static">
        <span className="m-row__leading"><span className="m-row__icon"><Icon /><StatusDot state={device.online ? 'online' : 'offline'} /></span></span>
        <span className="m-row__body">
          <span className="m-row__title">{device.name}</span>
          <span className="m-row__detail">{detail}</span>
        </span>
      </div>
    )
  }
  return (
    <>
      <SectionHeading>Devices</SectionHeading>
      {computers.error && !computers.data && <Notice>{computers.error}</Notice>}
      {desktops.length > 0 && <div className="m-list" aria-label="Computers">{desktops.map(row)}</div>}
      {phones.length > 0 && <div className="m-list" aria-label="Phones">{phones.map(row)}</div>}
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
        <SectionHeading>Account</SectionHeading>
        <Card>
          <div className="m-kv">
            <User size={20} className="m-faint" />
            <div>
              <span className="m-kv__label">Mousse ID</span>
              <span className="m-kv__value">{signedIn ? email ?? 'Signed in, no email on file' : 'Signed out'}</span>
            </div>
          </div>
          {usage && (
            <div className="m-kv">
              <Smartphone size={20} className="m-faint" />
              <div>
                <span className="m-kv__label">Devices</span>
                <span className="m-kv__value" data-testid="device-usage">{usage.used} of {usage.limit} devices</span>
              </div>
            </div>
          )}
          <Button variant="danger" block icon={<LogOut />} busy={signingOut} onClick={() => void signOut()}>Sign out</Button>
        </Card>

        {signedIn && <DevicesSection computers={devices} />}

        <SectionHeading>Appearance</SectionHeading>
        <Card>
          <Segmented<ThemePreference>
            label="Theme"
            value={appearance.theme}
            onChange={(theme) => setAppearance({ theme })}
            options={[{ value: 'mousse-dark', label: 'Mousse dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
          />
          <div className="m-swatches" role="radiogroup" aria-label="Accent colour">
            {ACCENT_COLORS.map((color) => {
              const selected = color.value.toLowerCase() === appearance.accentColor.toLowerCase()
              return (
                <button
                  key={color.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={color.label}
                  className="m-swatch"
                  style={{ ['--swatch' as string]: color.value }}
                  onClick={() => setAppearance({ accentColor: color.value })}
                >
                  {selected && <Check size={16} />}
                </button>
              )
            })}
          </div>
        </Card>

        <SectionHeading>About</SectionHeading>
        <Card>
          <div className="m-kv">
            <MousseLogo size={22} />
            <div><span className="m-kv__label">Mousse for phones</span><span className="m-kv__value">Version {__APP_VERSION__}</span></div>
          </div>
          <button type="button" className="m-disclosure" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
            <Info size={18} className="m-faint" />
            <span>Advanced</span>
            <ChevronDown size={16} className="m-disclosure__chevron" />
          </button>
          {advanced && (
            <dl className="m-advanced">
              <dt>Mousse ID server</dt>
              <dd className="font-mono">{signedIn?.idOrigin || 'Not signed in'}</dd>
              <dt>Account id</dt>
              <dd className="font-mono">{signedIn?.account.id ?? '—'}</dd>
            </dl>
          )}
        </Card>
      </div></div>
    </main>
  )
}
