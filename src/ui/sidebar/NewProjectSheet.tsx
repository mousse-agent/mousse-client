// New project on the phone, after the desktop's RemoteProjectDialog: the full path of a folder on the
// computer. The computer decides whether the folder can be a project; its refusal shows here and the
// sheet stays open for another try. A folder is opened, never created.
import { useEffect, useRef, useState } from 'react'
import type { OpenProjectResult, Project } from '../../connection/types'
import { Sheet } from '../components/Sheet'
import { Button, Field, Notice, Spinner } from '../components/primitives'

export interface NewProjectSheetProps {
  open: boolean
  computerName: string
  /** Opens the folder on the computer; missing while the computer is not connected or too old. */
  openProject?(path: string): Promise<OpenProjectResult>
  /** Paths of the projects the computer already has; the folders holding them are offered to start from. */
  projectPaths: readonly string[]
  onClose(): void
  onCreated(project: Project): void
}

export function NewProjectSheet({ open, computerName, openProject, projectPaths, onClose, onCreated }: NewProjectSheetProps) {
  const [path, setPath] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (open) setError(undefined)
  }, [open])
  const folders = parentFolders(projectPaths)
  const ready = !!openProject && !!path.trim() && !busy
  const submit = async () => {
    if (!ready || !openProject) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await openProject(path.trim())
      if (!result.ok) {
        setError(result.error)
        return
      }
      setPath('')
      onCreated(result.project)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Could not reach ${computerName}.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      title={`New project on ${computerName}`}
      onClose={onClose}
      dismissible={!busy}
      footer={
        <Button disabled={!ready} onClick={() => void submit()}>
          {busy ? <><Spinner size={14} /> Opening…</> : 'Open folder'}
        </Button>
      }
    >
      <form className="m-form" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <Field label={`Folder on ${computerName}`} hint="A folder that is already there. Its full path, from the root.">
          <input
            ref={field}
            className="m-input"
            value={path}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            enterKeyHint="go"
            placeholder="/Users/you/code/app"
            onChange={(event) => { setPath(event.target.value); setError(undefined) }}
          />
        </Field>
        {folders.length > 0 && (
          <section className="m-new-project__recents" aria-label="Start from">
            <h3 className="m-field__label">Where your projects are</h3>
            {folders.map((folder) => (
              <button key={folder} type="button" className="m-new-project__recent" title={folder} onClick={() => { setPath(folder); setError(undefined); field.current?.focus() }}>
                {folder}
              </button>
            ))}
          </section>
        )}
        {!openProject && <Notice tone="info">{`${computerName} is offline, or its Mousse is too old to add projects from this phone.`}</Notice>}
        {error && <Notice>{error}</Notice>}
      </form>
    </Sheet>
  )
}

/** The folders that hold the given projects, each once and ending in a slash, the most used first (at most 4). */
export function parentFolders(paths: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const trimmed = path.replace(/[\\/]+$/, '')
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (cut <= 0) continue
    const folder = trimmed.slice(0, cut + 1)
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([folder]) => folder)
}
