import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { Computer, EnrollmentProgress } from '../../connection/types'
import { useConnection } from '../hooks/connection'
import { errorMessage } from '../hooks/useAsync'
import { Sheet } from '../components/Sheet'
import { EnrollmentSteps, isEnrollmentFinished } from '../components/EnrollmentSteps'
import { Button, Field, ListRow, Notice, StatusDot } from '../components/primitives'
import { CircleCheck, Link2, Monitor, QrCode } from '../components/icons'

export type AddPhoneTarget =
  | { kind: 'computer'; computer: Computer }
  | { kind: 'pick' }
  | { kind: 'qr' }

function defaultDeviceName(): string {
  const agent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  const android = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(agent)
  if (android?.[1]) return android[1].trim()
  return 'Phone'
}

async function scanQr(): Promise<string> {
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner')
  const result = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    scanInstructions: 'Point the camera at the QR code in Mousse on your computer.'
  })
  if (!result.ScanResult) throw new Error('No QR code was read.')
  return result.ScanResult
}

export interface AddPhoneSheetProps {
  target: AddPhoneTarget | undefined
  computers: Computer[]
  onClose(): void
  /** Called after a successful enrollment, with the computer to open if known. */
  onAdded(nodeId?: string): void
}

export function AddPhoneSheet({ target, computers, onClose, onAdded }: AddPhoneSheetProps) {
  const connection = useConnection()
  const [picked, setPicked] = useState<Computer>()
  const [deviceName, setDeviceName] = useState(defaultDeviceName)
  const [progress, setProgress] = useState<EnrollmentProgress>()
  const [error, setError] = useState<string>()
  const [link, setLink] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [scanning, setScanning] = useState(false)
  const run = useRef(0)

  const computer = target?.kind === 'computer' ? target.computer : picked
  const working = !!progress && !isEnrollmentFinished(progress)

  useEffect(() => {
    run.current++
    setPicked(undefined)
    setProgress(undefined)
    setError(undefined)
    setLink('')
    setShowPaste(target?.kind === 'qr' && !Capacitor.isNativePlatform())
  }, [target])

  const track = useCallback(async (start: (onProgress: (progress: EnrollmentProgress) => void) => Promise<void>) => {
    const id = ++run.current
    setError(undefined)
    setProgress({ stage: 'requesting' })
    try {
      await start((next) => { if (run.current === id) setProgress(next) })
      if (run.current === id) setProgress({ stage: 'done' })
    } catch (cause) {
      if (run.current !== id) return
      setProgress((current) => (current && isEnrollmentFinished(current) && current.stage !== 'done' ? current : { stage: 'error', message: errorMessage(cause) }))
    }
  }, [])

  async function onScan() {
    setScanning(true)
    setError(undefined)
    try {
      const payload = await scanQr()
      await track((onProgress) => connection.enrollFromQr(payload, onProgress))
    } catch (cause) {
      setError(`${errorMessage(cause)} You can paste the pairing link instead.`)
      setShowPaste(true)
    } finally {
      setScanning(false)
    }
  }

  const title = target?.kind === 'qr' ? 'Scan QR code' : computer ? `Add this phone to ${computer.name}` : 'Add this phone'
  const done = progress?.stage === 'done'

  let body
  if (progress) {
    body = (
      <>
        <EnrollmentSteps progress={progress} computerName={computer?.name} />
        {done && (
          <div className="m-enroll__done">
            <CircleCheck size={22} />
            <span>This phone can now open threads on {computer?.name ?? 'the computer'}.</span>
          </div>
        )}
        <div className="m-sheet__actions">
          {done && <Button variant="primary" block onClick={() => onAdded(computer?.nodeId)}>Open {computer?.name ?? 'computer'}</Button>}
          {isEnrollmentFinished(progress) && !done && <Button variant="primary" block onClick={() => setProgress(undefined)}>Try again</Button>}
          {working && <Button variant="ghost" block onClick={() => { run.current++; setProgress(undefined) }}>Cancel</Button>}
        </div>
      </>
    )
  } else if (target?.kind === 'qr') {
    body = (
      <>
        <p className="m-sheet__lead">In Mousse on your computer, open Settings, then Phones, and show the pairing QR code.</p>
        {Capacitor.isNativePlatform() && (
          <Button variant="primary" block icon={<QrCode />} busy={scanning} onClick={() => void onScan()}>Open camera</Button>
        )}
        {showPaste && (
          <form className="m-form" onSubmit={(event) => {
            event.preventDefault()
            const payload = link.trim()
            void track((onProgress) => connection.enrollFromQr(payload, onProgress))
          }}>
            <Field label="Pairing link" hint="Starts with mousse://net/join">
              <div className="m-input-wrap">
                <Link2 size={17} />
                <input className="m-input" autoCapitalize="none" spellCheck={false} value={link} onChange={(event) => setLink(event.target.value)} placeholder="mousse://net/join?…" />
              </div>
            </Field>
            <Button type="submit" variant={Capacitor.isNativePlatform() ? 'secondary' : 'primary'} block disabled={!link.trim()}>Connect</Button>
          </form>
        )}
      </>
    )
  } else if (!computer) {
    const candidates = computers.filter((entry) => !entry.enrolled)
    body = candidates.length ? (
      <>
        <p className="m-sheet__lead">Choose the computer this phone should work with.</p>
        <div className="m-list">
          {candidates.map((entry) => (
            <ListRow key={entry.nodeId} disabled={!entry.online}
              leading={<span className="m-row__icon"><Monitor /><StatusDot state={entry.online ? 'online' : 'offline'} /></span>}
              title={entry.name} detail={entry.online ? 'Online' : 'Offline'} onClick={() => setPicked(entry)} />
          ))}
        </div>
      </>
    ) : <p className="m-sheet__lead">This phone is already added to every computer on your account. To add a new computer, scan its QR code.</p>
  } else {
    body = (
      <form className="m-form" onSubmit={(event) => {
        event.preventDefault()
        void track((onProgress) => connection.enrollWithComputer(computer.nodeId, deviceName.trim() || 'Phone', onProgress))
      }}>
        <p className="m-sheet__lead">{computer.name} will ask you to approve this phone. You will see the same 6-digit code on both screens.</p>
        <Field label="Name this phone">
          <input className="m-input" value={deviceName} maxLength={48} onChange={(event) => setDeviceName(event.target.value)} />
        </Field>
        {!computer.online && <Notice tone="info">{computer.name} is offline. Open Mousse on it first.</Notice>}
        <Button type="submit" variant="primary" block disabled={!computer.online}>Send request</Button>
      </form>
    )
  }

  return (
    <Sheet open={!!target} title={title} onClose={onClose} dismissible={!working}>
      {error && <Notice>{error}</Notice>}
      {body}
    </Sheet>
  )
}
