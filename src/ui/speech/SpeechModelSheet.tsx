import { useEffect, useRef, useState } from 'react'
import type {
  ComputerSpeech,
  LocalModelState,
  SpeechChoice,
  SpeechKind,
  SpeechLocalModel,
  SpeechOptions,
  SpeechProviderModel,
  SpeechSelection,
} from '../../connection/speech'
import { errorMessage } from '../hooks/useAsync'
import { Check, Download, X } from '../components/icons'
import { Button, Notice, Segmented, Spinner } from '../components/primitives'
import { Sheet } from '../components/Sheet'
import './speech.css'

/**
 * The desktop's first-use chooser (DictationModal / ReadAloudModal with SpeechModelPicker) as a
 * bottom sheet. The choices, the downloads and the saved choice all live on the computer, so the
 * desktop counts the model as chosen too.
 */

type Tab = 'provider' | 'local'

const TEXT: Record<SpeechKind, { title: string; lead: string; action: string; empty: string; examples: string }> = {
  dictation: {
    title: 'Choose a dictation model',
    lead: 'Speech is turned into text on your computer with the model you pick. You can change it later in Mousse on the computer under Settings, Models.',
    action: 'Use model and record',
    empty: 'No configured provider on the computer lists a speech-to-text model.',
    examples: "OpenAI's whisper-1 and gpt-4o-transcribe, and Groq's whisper-large-v3, appear after you sign in and refresh the provider's models under Providers on the computer.",
  },
  readAloud: {
    title: 'Choose a read aloud voice',
    lead: 'Messages are read on your computer with the model you pick, and play here. You can change it later in Mousse on the computer under Settings, Models.',
    action: 'Use model and read',
    empty: 'No configured provider on the computer lists a text-to-speech model.',
    examples: "OpenAI's tts-1 and gpt-4o-mini-tts appear after you sign in to OpenAI and refresh its models under Providers on the computer.",
  },
}

export function formatModelSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function downloadPercent(state: Extract<LocalModelState, { status: 'downloading' }>): number {
  return state.totalBytes > 0 ? Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100)) : 0
}

const sameChoice = (a: SpeechChoice | null, b: SpeechChoice | null): boolean =>
  !!a && !!b && a.source === b.source && a.modelId === b.modelId && (a.source === 'local' || (b.source === 'provider' && a.providerId === b.providerId))

function choiceOf(selection: SpeechSelection | null): SpeechChoice | null {
  if (!selection) return null
  return selection.source === 'provider' && selection.providerId
    ? { source: 'provider', providerId: selection.providerId, modelId: selection.modelId }
    : { source: 'local', modelId: selection.modelId }
}

export interface SpeechModelSheetProps {
  open: boolean
  kind: SpeechKind
  speech: ComputerSpeech
  /** True when a recording or reading waits for the choice; the button then says so. */
  continues: boolean
  onClose(): void
  onChosen(selection: SpeechSelection): void
}

export function SpeechModelSheet({ open, kind, speech, continues, onClose, onChosen }: SpeechModelSheetProps) {
  const [options, setOptions] = useState<SpeechOptions>()
  const [loadError, setLoadError] = useState<string>()
  const [draft, setDraft] = useState<SpeechChoice | null>(null)
  const [tab, setTab] = useState<Tab | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [states, setStates] = useState<Record<string, LocalModelState>>({})
  const downloads = useRef(new Map<string, AbortController>())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setOptions(undefined)
    setLoadError(undefined)
    setError(undefined)
    setTab(null)
    speech.options(kind).then((value) => {
      if (cancelled) return
      setOptions(value)
      setDraft(choiceOf(value.selection))
      setStates((current) => ({ ...Object.fromEntries(value.local.map((model) => [model.id, model.state])), ...pick(current, value.local) }))
    }, (cause) => { if (!cancelled) setLoadError(errorMessage(cause)) })
    return () => { cancelled = true }
  }, [open, kind, speech])

  const text = TEXT[kind]
  const shownTab: Tab = tab ?? draft?.source ?? (options && options.providers.length === 0 ? 'local' : 'provider')

  const download = (model: SpeechLocalModel) => {
    const controller = new AbortController()
    downloads.current.set(model.id, controller)
    const update = (state: LocalModelState) => { if (mounted.current) setStates((current) => ({ ...current, [model.id]: state })) }
    update({ status: 'downloading', receivedBytes: 0, totalBytes: model.bytes })
    speech.download(kind, model.id, { onState: update, signal: controller.signal }).then(
      (state) => {
        update(state)
        if (state.status === 'downloaded' && mounted.current) setDraft((current) => current ?? { source: 'local', modelId: model.id })
      },
      (cause) => update(controller.signal.aborted ? { status: 'not-downloaded' } : { status: 'error', message: errorMessage(cause) }),
    ).finally(() => { if (downloads.current.get(model.id) === controller) downloads.current.delete(model.id) })
  }

  const confirm = async () => {
    if (!draft) return
    setSaving(true)
    setError(undefined)
    try {
      const selection = await speech.choose(kind, draft)
      if (mounted.current) onChosen(selection)
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <Sheet open={open} title={text.title} onClose={onClose}>
      <p className="m-sheet__lead">{text.lead}</p>
      {loadError && <Notice>{loadError}</Notice>}
      {!options && !loadError && <div className="m-speech-empty" role="status"><Spinner size={16} /> Loading models</div>}
      {options && (
        <>
          <Segmented<Tab>
            label={kind === 'dictation' ? 'Dictation model source' : 'Read aloud model source'}
            value={shownTab}
            onChange={setTab}
            options={[{ value: 'provider', label: 'Providers' }, { value: 'local', label: 'Local' }]}
          />
          {shownTab === 'provider' ? (
            <ProviderList models={options.providers} draft={draft} onSelect={setDraft} empty={text} onShowLocal={() => setTab('local')} />
          ) : (
            <div className="m-options" role="radiogroup" aria-label="Local models">
              {options.local.map((model) => (
                <LocalRow
                  key={model.id}
                  model={model}
                  state={states[model.id] ?? model.state}
                  selected={draft?.source === 'local' && draft.modelId === model.id}
                  onSelect={() => setDraft({ source: 'local', modelId: model.id })}
                  onDownload={() => download(model)}
                  onCancel={() => downloads.current.get(model.id)?.abort()}
                />
              ))}
            </div>
          )}
        </>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="m-speech-sheet__footer">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={saving} disabled={!draft || !options} onClick={() => void confirm()}>
          {continues ? text.action : 'Use model'}
        </Button>
      </div>
    </Sheet>
  )
}

/** Keeps states the phone saw change (downloads it started) over the loaded snapshot. */
function pick(current: Record<string, LocalModelState>, local: SpeechLocalModel[]): Record<string, LocalModelState> {
  return Object.fromEntries(local.flatMap((model) => (current[model.id]?.status === 'downloading' ? [[model.id, current[model.id]]] : [])))
}

function ProviderList({ models, draft, onSelect, empty, onShowLocal }: {
  models: SpeechProviderModel[]
  draft: SpeechChoice | null
  onSelect(choice: SpeechChoice): void
  empty: { empty: string; examples: string }
  onShowLocal(): void
}) {
  if (models.length === 0) {
    return (
      <div className="m-speech-empty m-speech-empty--text">
        <p>{empty.empty}</p>
        <p>{empty.examples}</p>
        <p>You can also <button type="button" className="m-speech-link" onClick={onShowLocal}>use a local model</button> that runs on the computer.</p>
      </div>
    )
  }
  return (
    <div className="m-options" role="radiogroup" aria-label="Provider models">
      {models.map((model) => {
        const choice: SpeechChoice = { source: 'provider', providerId: model.providerId, modelId: model.modelId }
        const selected = sameChoice(draft, choice)
        return (
          <button
            key={`${model.providerId}:${model.modelId}`}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`m-option${selected ? ' m-option--selected' : ''}`}
            onClick={() => onSelect(choice)}
          >
            <span className="m-option__body">
              <span className="m-option__title">{model.label}</span>
              <span className="m-option__detail">{model.providerLabel}</span>
            </span>
            {selected && <Check size={18} className="m-option__check" />}
          </button>
        )
      })}
    </div>
  )
}

function LocalRow({ model, state, selected, onSelect, onDownload, onCancel }: {
  model: SpeechLocalModel
  state: LocalModelState
  selected: boolean
  onSelect(): void
  onDownload(): void
  onCancel(): void
}) {
  const downloaded = state.status === 'downloaded'
  const size = formatModelSize(model.bytes)
  return (
    <div className={`m-speech-model${selected ? ' m-option--selected' : ''}`} data-downloaded={downloaded || undefined}>
      <button type="button" role="radio" aria-checked={selected} aria-disabled={!downloaded} className="m-speech-model__main" onClick={() => downloaded && onSelect()}>
        <span className="m-option__body">
          <span className="m-option__title">{model.label}</span>
          <span className="m-option__detail">{model.parameters} parameters · {size} · {model.license}</span>
          <span className="m-option__detail">{downloaded ? model.description : `${model.description}. Download it to use it.`}</span>
          {state.status === 'error' && <span className="m-speech-model__error">{state.message}</span>}
        </span>
        {selected && <Check size={18} className="m-option__check" />}
      </button>
      <div className="m-speech-model__actions">
        {model.homepage && <a className="m-speech-link" href={model.homepage} target="_blank" rel="noopener noreferrer">Model card</a>}
        {state.status === 'downloading' ? (
          <>
            <span className="m-speech-progress" role="progressbar" aria-label={`Downloading ${model.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadPercent(state)}>
              <span style={{ width: `${downloadPercent(state)}%` }} />
            </span>
            <span className="m-speech-model__percent">{downloadPercent(state)}%</span>
            <button type="button" className="m-speech-icon-button" aria-label={`Cancel downloading ${model.label}`} onClick={onCancel}><X size={15} /></button>
          </>
        ) : downloaded ? (
          <span className="m-speech-model__done"><Check size={14} /> Downloaded</span>
        ) : (
          <button
            type="button"
            className="m-speech-icon-button m-speech-icon-button--labelled"
            aria-label={state.status === 'error' ? `Retry downloading ${model.label}` : `Download ${model.label}`}
            onClick={onDownload}
          >
            <Download size={15} /> {state.status === 'error' ? 'Retry' : `Download ${size}`}
          </button>
        )}
      </div>
    </div>
  )
}
