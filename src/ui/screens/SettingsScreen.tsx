import { useState } from 'react'
import { accountEmail, deviceUsage, useAccount, useConnection } from '../hooks/connection'
import { useAsync } from '../hooks/useAsync'
import { useAppearance } from '../hooks/useAppearance'
import { useRouter } from '../state/router'
import { ACCENT_COLORS, type ThemePreference } from '../theme/appearance'
import { Check, ChevronDown, ChevronLeft, Info, LogOut, Smartphone, User } from '../components/icons'
import { Button, Card, IconButton, MousseLogo, SectionHeading, Segmented, TopBar } from '../components/primitives'

export function SettingsScreen() {
  const connection = useConnection()
  const account = useAccount()
  const router = useRouter()
  const { appearance, setAppearance } = useAppearance()
  const [advanced, setAdvanced] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const signedIn = account.status === 'signed-in' ? account : undefined
  const email = accountEmail(account)
  const devices = useAsync(() => signedIn ? connection.listComputers() : Promise.resolve(undefined), [connection, signedIn?.account.id])
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
