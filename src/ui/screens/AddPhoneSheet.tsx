import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { EnrollmentProgress } from '../../connection/types'
import { useConnection } from '../hooks/connection'
import { errorMessage } from '../hooks/useAsync'
import { Sheet } from '../components/Sheet'
import { EnrollmentSteps, isEnrollmentFinished } from '../components/EnrollmentSteps'
import { Button, Field, Notice } from '../components/primitives'
import { CircleCheck, Link2, QrCode } from '../components/icons'

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
  open: boolean
  onClose(): void
  /** Called after the phone joined. */
  onAdded(): void
}

/**
 * Adds this phone with the QR code a computer shows: the way in when joining on its own cannot
 * work, for example a computer signed in to another Mousse ID server.
 */
export function AddPhoneSheet({ open, onClose, onAdded }: AddPhoneSheetProps) {
  const connection = useConnection()
  const [progress, setProgress] = useState<EnrollmentProgress>()
  const [error, setError] = useState<string>()
  const [link, setLink] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [scanning, setScanning] = useState(false)
  const run = useRef(0)

  const working = !!progress && !isEnrollmentFinished(progress)

  useEffect(() => {
    run.current++
    setProgress(undefined)
    setError(undefined)
    setLink('')
    setShowPaste(open && !Capacitor.isNativePlatform())
  }, [open])

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

  const done = progress?.stage === 'done'

  let body
  if (progress) {
    body = (
      <>
        <EnrollmentSteps progress={progress} />
        {done && (
          <div className="m-enroll__done">
            <CircleCheck size={22} />
            <span>This phone can now open threads on the computer.</span>
          </div>
        )}
        <div className="m-sheet__actions">
          {done && <Button variant="primary" block onClick={onAdded}>Done</Button>}
          {isEnrollmentFinished(progress) && !done && <Button variant="primary" block onClick={() => setProgress(undefined)}>Try again</Button>}
          {working && <Button variant="ghost" block onClick={() => { run.current++; setProgress(undefined) }}>Cancel</Button>}
        </div>
      </>
    )
  } else {
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
  }

  return (
    <Sheet open={open} title="Add with a QR code" onClose={onClose} dismissible={!working}>
      {error && <Notice>{error}</Notice>}
      {body}
    </Sheet>
  )
}
