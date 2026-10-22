import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { ChatMode, ComposerCommand, ComposerSkill, ContextUsage, ImageAttachment, LlmProviderOption } from '../../connection/types'
import { ArrowUp, ChevronDown, Loader2, Mic, Paperclip, Sparkles, Square, Stop, X } from './icons'
import type { ComputerSpeech } from '../../connection/speech'
import { formatDuration, useDictation } from '../speech/useDictation'
import { insertTranscript } from '../speech/insertTranscript'
import { SpeechWave } from '../speech/SpeechWave'
import { SpeechModelSheet } from '../speech/SpeechModelSheet'
import { useFinePointer } from '../hooks/useMediaQuery'
import { extractFamilyLabel, parseModelVariant, parseThinkingSuffixFromModelId } from '../lib/modelVariants'
import { loadDraft, saveDraft } from '../lib/composerPrefs'
import { MAX_IMAGES, readImage, type PendingImage } from '../lib/images'
import { ProviderIcon } from './providerIcons'
import { ContextRing, ContextSheet, EffortSheet, MODE_META, ModeSheet, ModelSheet, SkillSheet, effortSummary, isPlanless } from './ComposerSheets'

/** What the computer's composer offers; without it the composer is a plain text box. */
export interface ComposerControls {
  providers: LlmProviderOption[]
  /** The thread's model, or the computer's default. */
  providerId?: string
  modelId?: string
  onSelectModel(providerId: string, modelId: string): void
  modes: string[]
  mode: string
  onSelectMode(mode: string): void
  skills: ComposerSkill[]
  commands: ComposerCommand[]
  usage?: ContextUsage
  favorites: Set<string>
  onToggleFavorite(key: string): void
}

export interface SendExtras {
  mode?: ChatMode
  images?: ImageAttachment[]
}

export interface ComposerProps {
  /** A turn is running: an empty composer's button stops it; a message is queued instead of sent. */
  active: boolean
  disabled?: boolean
  placeholder?: string
  /** Keeps the unsent text across visits (per thread). */
  draftKey?: string
  /** Replaces the text, for example when a queued message is moved back for editing; `append` adds it after the text instead. */
  prefill?: { text: string; key: number; append?: boolean }
  controls?: ComposerControls
  /** The computer's speech models: an empty composer's button records and types the transcript. */
  speech?: ComputerSpeech
  onSend(text: string, extras: SendExtras): Promise<boolean> | boolean
  onStop(): void
  /** `/steer <text>`: guidance for the running turn. */
  onSteer?(text: string): Promise<boolean> | boolean
  /** `/new [title]`: a new thread. */
  onNewThread?(title: string): void
}

const MAX_HEIGHT = 168
/** Commands the phone runs itself, or that only make sense on the desktop. */
const DESKTOP_ONLY_COMMANDS = new Set(['usage'])

interface ParsedCommand { name: string; args: string }

function parseCommand(text: string, commands: ComposerCommand[]): ParsedCommand | undefined {
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return undefined
  const typed = match[1].toLowerCase()
  const command = commands.find((entry) => entry.name === typed || entry.aliases?.includes(typed))
  return command ? { name: command.name, args: (match[2] ?? '').trim() } : undefined
}

function modelLabel(controls: ComposerControls): { title: string; context?: string } | undefined {
  const { providerId, modelId, providers } = controls
  if (!providerId || !modelId) return undefined
  const models = providers.find((provider) => provider.id === providerId)?.models ?? []
  const base = parseThinkingSuffixFromModelId(modelId).baseId
  const model = models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.id === base)
  if (!model) return { title: base }
  return { title: extractFamilyLabel(model.label), context: parseModelVariant(model).context }
}

/**
 * The desktop composer at phone size: the raised text box, then a footer with the mode pill, the
 * model button, the effort pill, the context ring, attach, and send / queue / stop. Menus open as
 * bottom sheets. On touch screens Return inserts a new line and the button sends; with a hardware
 * keyboard and fine pointer, Enter sends and Shift+Enter breaks.
 */
export function Composer({ active, disabled = false, placeholder, draftKey, prefill, controls, speech, onSend, onStop, onSteer, onNewThread }: ComposerProps) {
  const [text, setText] = useState(() => (draftKey ? loadDraft(draftKey) : ''))
  const [images, setImages] = useState<PendingImage[]>([])
  const [skill, setSkill] = useState<ComposerSkill>()
  const [error, setError] = useState<string>()
  const [sheet, setSheet] = useState<'model' | 'effort' | 'mode' | 'skills' | 'context'>()
  const [skillQuery, setSkillQuery] = useState('')
  const [sheetKey, setSheetKey] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string>()
  const field = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const finePointer = useFinePointer()

  // Dictated text goes where the caret is, or at the end when the box is not focused.
  const insertDictation = (transcript: string) => {
    const element = field.current
    const focused = !!element && document.activeElement === element
    let caret = 0
    setText((current) => {
      const next = insertTranscript(current, focused ? element.selectionStart : current.length, focused ? element.selectionEnd : current.length, transcript)
      caret = next.caret
      return next.value
    })
    if (focused) requestAnimationFrame(() => element.setSelectionRange(caret, caret))
  }
  const dictation = useDictation({ speech, disabled, onTranscript: insertDictation })
  const voice = dictation.available
    ? {
        recording: dictation.isRecording,
        busy: dictation.recordingPending || dictation.transcribing,
        disabled: disabled || dictation.recordingPending || dictation.transcribing,
        onStart: dictation.start,
        onStop: dictation.stop,
      }
    : undefined

  useEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  useEffect(() => { if (draftKey) saveDraft(draftKey, text) }, [draftKey, text])

  useEffect(() => {
    if (!prefill) return
    setText((text) => (prefill.append && text.trim() ? `${text}\n\n${prefill.text}` : prefill.text))
    field.current?.focus()
  }, [prefill])

  const commands = useMemo(() => (controls?.commands ?? []).filter((command) => !DESKTOP_ONLY_COMMANDS.has(command.name)), [controls?.commands])
  const suggestions = useMemo(() => {
    if (!text.startsWith('/') || /\s/.test(text) || text === dismissedFor) return []
    const query = text.slice(1).toLowerCase()
    return commands.filter((command) => [command.name, ...(command.aliases ?? [])].some((name) => name.toLowerCase().includes(query)))
  }, [text, commands, dismissedFor])
  useEffect(() => setHighlight(0), [suggestions.length])

  const hasContent = text.trim().length > 0 || images.length > 0
  const canSend = !disabled && hasContent

  const openSkills = (query: string) => {
    setSkillQuery(query)
    setSheetKey((value) => value + 1)
    setSheet('skills')
  }

  async function runCommand(command: ParsedCommand): Promise<boolean> {
    switch (command.name) {
      case 'stop':
        onStop()
        return true
      case 'skills':
        openSkills(command.args)
        return true
      case 'new':
        if (!onNewThread) return false
        onNewThread(command.args)
        return true
      case 'steer':
        if (!command.args) return false
        // Without a running turn the guidance is an ordinary message, as on the desktop.
        if (!active || !onSteer) return onSend(command.args, extras())
        return onSteer(command.args)
      default:
        return false
    }
  }

  function extras(): SendExtras {
    const mode: ChatMode | undefined = skill ? { type: 'skill', skillId: skill.id } : controls && controls.mode !== 'agent' ? controls.mode : undefined
    return {
      ...(mode !== undefined ? { mode } : {}),
      ...(images.length ? { images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })) } : {})
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!hasContent) { if (active) onStop(); return }
    if (!canSend) return
    const draft = text
    const command = !images.length && !skill ? parseCommand(draft, commands) : undefined
    if (command) {
      setText('')
      const handled = await runCommand(command)
      if (handled) return
    }
    const sentImages = images
    const sentSkill = skill
    const payload = extras()
    setText('')
    setImages([])
    setSkill(undefined)
    setError(undefined)
    // Like the desktop, an image-only message still needs words for the agent.
    const sent = await onSend(draft.trim() || '[Image attachment]', payload)
    if (!sent) {
      setText((current) => current || draft)
      setImages((current) => current.length ? current : sentImages)
      setSkill((current) => current ?? sentSkill)
    }
  }

  function applySuggestion(command: ComposerCommand) {
    if (command.name === 'skills') { setText(''); openSkills(''); return }
    if (command.argsHint) {
      setText(`/${command.name} `)
      field.current?.focus()
      return
    }
    setText(`/${command.name}`)
    void (async () => {
      setText('')
      if (!(await runCommand({ name: command.name, args: '' }))) {
        const sent = await onSend(`/${command.name}`, extras())
        if (!sent) setText(`/${command.name}`)
      }
    })()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); setDismissedFor(text); return }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        const exact = parseCommand(text, commands)
        if (!exact) { event.preventDefault(); applySuggestion(suggestions[highlight]); return }
      }
    }
    if (event.key === 'Backspace' && !text && (images.length || skill)) {
      if (skill) setSkill(undefined)
      else setImages((current) => current.slice(0, -1))
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && finePointer && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  async function addFiles(files: File[]) {
    if (!files.length) return
    const room = MAX_IMAGES - images.length
    if (room <= 0) { setError(`Up to ${MAX_IMAGES} images per message.`); return }
    const read = await Promise.allSettled(files.slice(0, room).map(readImage))
    const ok = read.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const failed = read.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    setImages((current) => [...current, ...ok].slice(0, MAX_IMAGES))
    setError(failed ? (failed.reason instanceof Error ? failed.reason.message : 'An image could not be read.') : files.length > room ? `Up to ${MAX_IMAGES} images per message.` : undefined)
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!controls) return
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    void addFiles(files)
  }

  const label = controls ? modelLabel(controls) : undefined
  const effort = controls ? effortSummary(controls.providers, controls.providerId, controls.modelId) : undefined
  const mode = controls?.mode ?? 'agent'
  const modeMeta = skill ? { label: skill.name, icon: <Sparkles size={15} /> } : MODE_META[mode] ?? MODE_META.agent
  const actionLabel = hasContent ? (active ? 'Queue message' : 'Send') : active ? 'Stop' : 'Send'
  const shownPlaceholder = placeholder ?? (active ? 'Running… send queues next' : 'Message')

  return (
    <div className="m-composer-wrap">
      {suggestions.length > 0 && (
        <div className="m-command-suggestions" role="listbox" aria-label="Commands">
          {suggestions.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className="m-command"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applySuggestion(command)}
            >
              <span className="m-command__name">/{command.name}{command.argsHint && <span className="m-command__args"> {command.argsHint}</span>}</span>
              <span className="m-command__detail">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <form className="m-composer" onSubmit={submit} data-active={active || undefined} data-controls={controls ? '' : undefined}>
        {error && <p className="m-composer__error" role="alert">{error}</p>}
        {dictation.error && (
          <div className="m-composer__voice-error" role="alert">
            <p>{dictation.error}</p>
            <button type="button" disabled={disabled || dictation.recordingPending || dictation.transcribing} onClick={dictation.start}>Retry microphone</button>
            <button type="button" onClick={dictation.dismissError}>Dismiss</button>
          </div>
        )}
        {dictation.notice && <p className="m-composer__voice-notice" role="status">{dictation.notice}</p>}
        {(images.length > 0 || skill || dictation.isRecording || dictation.transcribing) && (
          <div className="m-composer__attachments">
            {dictation.isRecording && (
              <span className="m-attachment m-attachment--recording" role="status" aria-label={`Recording ${formatDuration(dictation.recordingDuration)}`}>
                <Mic size={13} strokeWidth={2} />
                <SpeechWave levels={dictation.levels} />
                <span>{formatDuration(dictation.recordingDuration)}</span>
                <button type="button" aria-label="Discard recording" onClick={dictation.cancel}><X size={13} /></button>
              </span>
            )}
            {dictation.transcribing && (
              <span className="m-attachment m-attachment--transcribing" role="status">
                <Loader2 size={13} strokeWidth={2} className="m-speech-spin" />
                <span>{dictation.partial ? dictation.partial : 'Transcribing…'}</span>
                <button type="button" aria-label="Stop transcribing" onClick={dictation.cancel}><X size={13} /></button>
              </span>
            )}
            {skill && (
              <span className="m-attachment m-attachment--skill">
                <Sparkles size={14} />
                <span>{skill.name}</span>
                <button type="button" aria-label={`Remove skill ${skill.name}`} onClick={() => setSkill(undefined)}><X size={13} /></button>
              </span>
            )}
            {images.map((image) => (
              <span key={image.id} className="m-attachment">
                <img src={image.preview} alt="" />
                <span>{image.name}</span>
                <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((entry) => entry.id !== image.id))}><X size={13} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="m-composer__row">
          <textarea
            ref={field}
            className="m-composer__input"
            rows={1}
            value={text}
            placeholder={shownPlaceholder}
            aria-label="Message"
            enterKeyHint={finePointer ? 'send' : 'enter'}
            disabled={disabled}
            onChange={(event) => { setText(event.target.value); setDismissedFor(undefined) }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {!controls && <ActionButton label={actionLabel} hasContent={hasContent} active={active} canSend={canSend} onStop={onStop} voice={voice} />}
        </div>
        {controls && (
          <div className="m-composer__footer">
            <div className="m-composer__pills">
              <button type="button" className="m-pill" aria-label={`Mode: ${modeMeta.label}`} aria-haspopup="dialog" onClick={() => skill ? setSkill(undefined) : setSheet('mode')}>
                {modeMeta.icon}<span className="m-pill__label">{modeMeta.label}</span>
              </button>
              <button type="button" className="m-pill m-pill--model" aria-label={`Model: ${label?.title ?? 'Select model'}`} aria-haspopup="dialog" onClick={() => setSheet('model')}>
                {controls.providerId && <ProviderIcon providerId={controls.providerId} size={14} />}
                <span className="m-pill__model">{label?.title ?? 'Select model'}</span>
                {label?.context && <span className="m-pill__context">· {label.context}</span>}
                <ChevronDown size={12} />
              </button>
              {effort && (
                <button type="button" className="m-pill" aria-label={`Reasoning effort: ${effort}`} aria-haspopup="dialog" onClick={() => setSheet('effort')}>
                  <span>{effort}</span><ChevronDown size={12} />
                </button>
              )}
            </div>
            <div className="m-composer__tools">
              {controls.usage && !isPlanless(controls.providerId) && <ContextRing usage={controls.usage} onClick={() => setSheet('context')} />}
              <button type="button" className="m-composer__icon" aria-label="Attach images" disabled={disabled} onClick={() => picker.current?.click()}>
                <Paperclip size={18} />
              </button>
              <ActionButton label={actionLabel} hasContent={hasContent} active={active} canSend={canSend} onStop={onStop} voice={voice} />
            </div>
          </div>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          data-testid="composer-file-input"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void addFiles(files)
          }}
        />
      </form>
      {speech && (
        <SpeechModelSheet
          open={dictation.chooser.open}
          kind="dictation"
          speech={speech}
          continues={dictation.chooser.continues}
          onClose={dictation.chooser.close}
          onChosen={dictation.chooser.chosen}
        />
      )}
      {controls && (
        <>
          <ModelSheet
            open={sheet === 'model'}
            onClose={() => setSheet(undefined)}
            providers={controls.providers}
            providerId={controls.providerId}
            modelId={controls.modelId}
            favorites={controls.favorites}
            onToggleFavorite={controls.onToggleFavorite}
            onSelect={controls.onSelectModel}
          />
          {controls.providerId && controls.modelId && (
            <EffortSheet
              open={sheet === 'effort'}
              onClose={() => setSheet(undefined)}
              providers={controls.providers}
              providerId={controls.providerId}
              modelId={controls.modelId}
              onSelect={controls.onSelectModel}
            />
          )}
          <ModeSheet open={sheet === 'mode'} onClose={() => setSheet(undefined)} modes={controls.modes} mode={mode} providerId={controls.providerId} onSelect={controls.onSelectMode} />
          <SkillSheet key={sheetKey} open={sheet === 'skills'} onClose={() => setSheet(undefined)} skills={controls.skills} initialQuery={skillQuery} onSelect={(picked) => { setSkill(picked); field.current?.focus() }} />
          <ContextSheet open={sheet === 'context'} onClose={() => setSheet(undefined)} usage={controls.usage} />
        </>
      )}
    </div>
  )
}

interface VoiceAction {
  recording: boolean
  busy: boolean
  disabled: boolean
  onStart(): void
  onStop(): void
}

function ActionButton({ label, hasContent, active, canSend, onStop, voice }: { label: string; hasContent: boolean; active: boolean; canSend: boolean; onStop(): void; voice?: VoiceAction }) {
  // As on the desktop: recording turns the button into a stop square; an empty, idle composer offers the microphone.
  if (voice?.recording) {
    return (
      <button type="button" className="m-composer__action m-composer__action--recording" aria-label="Stop recording" onClick={voice.onStop}>
        <Square size={15} strokeWidth={2} fill="currentColor" />
      </button>
    )
  }
  if (!hasContent && !active && voice) {
    return (
      <button type="button" className="m-composer__action" aria-label="Voice input" aria-busy={voice.busy || undefined} disabled={voice.disabled} onClick={voice.onStart}>
        {voice.busy ? <Loader2 size={18} className="m-speech-spin" /> : <Mic size={18} />}
      </button>
    )
  }
  if (!hasContent && active) {
    return (
      <button type="button" className="m-composer__action m-composer__action--stop" aria-label="Stop" onClick={onStop}>
        <Stop size={18} />
      </button>
    )
  }
  return (
    <button type="submit" className="m-composer__action" aria-label={label} disabled={!canSend} data-ready={canSend || undefined}>
      <ArrowUp size={19} />
    </button>
  )
}
