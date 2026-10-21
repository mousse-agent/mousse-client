import { useState } from 'react'
import type { Computer } from '../../connection/types'
import { useComputers } from '../hooks/connection'
import { useRouter } from '../state/router'
import { EmptyState } from '../components/EmptyState'
import { ChevronRight, Monitor, Plus, QrCode, RefreshCw, Settings, Smartphone } from '../components/icons'
import { Button, IconButton, ListRow, MousseLogo, Notice, SectionHeading, Spinner, StatusDot, TopBar } from '../components/primitives'
import { AddPhoneSheet, type AddPhoneTarget } from './AddPhoneSheet'

function lastSeen(computer: Computer): string {
  if (computer.online) return 'Online'
  if (!computer.lastSeenAt) return 'Offline'
  const days = Math.floor((Date.now() - computer.lastSeenAt) / 86_400_000)
  if (days < 1) return 'Offline · seen today'
  if (days === 1) return 'Offline · seen yesterday'
  return `Offline · seen ${days} days ago`
}

export function ComputersScreen() {
  const router = useRouter()
  const computers = useComputers()
  const [target, setTarget] = useState<AddPhoneTarget>()

  const list = computers.data ?? []
  const desktops = list.filter((computer) => computer.kind === 'computer')
  const phones = list.filter((computer) => computer.kind === 'phone')

  function open(computer: Computer) {
    if (!computer.enrolled) { setTarget({ kind: 'computer', computer }); return }
    router.push({ name: 'computer', nodeId: computer.nodeId })
  }

  return (
    <main className="m-screen">
      <TopBar
        leading={<span className="m-topbar__brand"><MousseLogo size={24} /></span>}
        title="Computers"
        trailing={<>
          <IconButton label="Refresh" onClick={computers.reload}><RefreshCw /></IconButton>
          <IconButton label="Settings" onClick={() => router.push({ name: 'settings' })}><Settings /></IconButton>
        </>}
      />
      <div className="m-scroll">
        <div className="m-content">
          {computers.error && <Notice>{computers.error}</Notice>}
          {computers.loading && !computers.data && <div className="m-loading"><Spinner label="Loading computers" /></div>}

          {computers.data && desktops.length === 0 && (
            <EmptyState
              title="No computers yet"
              body="Open Mousse on your computer and sign in with the same Mousse ID, or scan the pairing QR code it shows."
              actions={<Button variant="primary" icon={<QrCode />} onClick={() => setTarget({ kind: 'qr' })}>Scan QR code</Button>}
            />
          )}

          {desktops.length > 0 && (
            <>
              <SectionHeading>Your computers</SectionHeading>
              <div className="m-list">
                {desktops.map((computer) => (
                  <ListRow
                    key={computer.nodeId}
                    leading={<span className="m-row__icon"><Monitor /><StatusDot state={computer.online ? 'online' : 'offline'} /></span>}
                    title={computer.name}
                    detail={computer.enrolled ? lastSeen(computer) : `${computer.online ? 'Online' : 'Offline'} · this phone is not added yet`}
                    trailing={computer.enrolled ? <ChevronRight className="m-faint" /> : <span className="m-pill">Add this phone</span>}
                    disabled={!computer.online && !computer.enrolled}
                    onClick={() => open(computer)}
                  />
                ))}
              </div>
            </>
          )}

          {phones.length > 0 && (
            <>
              <SectionHeading>Phones</SectionHeading>
              <div className="m-list">
                {phones.map((phone) => (
                  <div key={phone.nodeId} className="m-row m-row--static">
                    <span className="m-row__leading"><span className="m-row__icon"><Smartphone /><StatusDot state={phone.online ? 'online' : 'offline'} /></span></span>
                    <span className="m-row__body">
                      <span className="m-row__title">{phone.name}</span>
                      <span className="m-row__detail">{phone.online ? 'Online' : 'Offline'}</span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {desktops.length > 0 && (
            <div className="m-actions-row">
              <Button icon={<QrCode />} onClick={() => setTarget({ kind: 'qr' })}>Scan QR code</Button>
              <Button icon={<Plus />} onClick={() => setTarget({ kind: 'pick' })}>Add this phone</Button>
            </div>
          )}
        </div>
      </div>
      <AddPhoneSheet
        target={target}
        computers={desktops}
        onClose={() => setTarget(undefined)}
        onAdded={(nodeId) => {
          setTarget(undefined)
          computers.reload()
          if (nodeId) router.push({ name: 'computer', nodeId })
        }}
      />
    </main>
  )
}
