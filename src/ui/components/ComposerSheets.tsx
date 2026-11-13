// Phone versions of the desktop composer's menus (ModelFamilyMenu with its run settings from
// ComposerEffortPicker, the /skills picker and the context-usage popover), as bottom sheets.
import { useMemo, useState, type ReactNode } from 'react'
import type { ComposerSkill, ContextUsage, LlmProviderOption, PermissionMode, QueuedMessage } from '../../connection/types'
import {
  extractFamilyLabel,
  findModelFamily,
  formatEffortLabel,
  getCurrentEffort,
  getEffortsForModel,
  getModelFastToggle,
  groupProviderModels,
  parseModelVariant,
  parseThinkingSuffixFromModelId,
  resolveModelVariant,
  shortModelName,
  applyEffortToModelId,
  type ModelFamily
} from '../lib/modelVariants'
import { ArrowDown, ArrowUp, Check, Copy, LayoutGrid, Pencil, ShieldCheck, ShieldOff, Sparkles, Star, Steer, Trash2, Wand2, Zap } from './icons'
import { ProviderIcon } from './providerIcons'
import { SearchField } from './primitives'
import { Sheet } from './Sheet'

/** Providers that cannot plan (the desktop hides Plan for them). */
export const isPlanless = (providerId: string | undefined) => !!providerId && providerId.toLowerCase().includes('antigravity')

function SheetOption({ selected, onClick, leading, title, detail, trailing, label }: {
  selected?: boolean
  onClick(): void
  leading?: ReactNode
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  label?: string
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected ?? false} aria-label={label} className={`m-option${selected ? ' m-option--selected' : ''}`} onClick={onClick}>
      {leading && <span className="m-option__leading">{leading}</span>}
      <span className="m-option__body">
        <span className="m-option__title">{title}</span>
        {detail && <span className="m-option__detail">{detail}</span>}
      </span>
      {trailing}
      {selected && <Check size={18} className="m-option__check" />}
    </button>
  )
}

interface FlatEntry {
  providerId: string
  providerLabel: string
  family: ModelFamily
  key: string
}

/** Same rule as the desktop: keep the current effort when the new family has it. */
function initialVariantOptions(family: ModelFamily, selectedModelId: string, preferredEffort?: string) {
  const { baseId, effort: effortFromId } = parseThinkingSuffixFromModelId(selectedModelId)
  const selected = family.variants.find((variant) => variant.id === selectedModelId) ?? family.variants.find((variant) => variant.id === baseId)
  const candidate = effortFromId ?? preferredEffort
  const effort = (candidate && family.efforts.includes(candidate) ? candidate : undefined) ?? selected?.effort ?? family.efforts[0]
  return { context: selected?.context ?? family.contexts[0], effort, speed: selected?.speed ?? family.speeds[0] }
}

export function ModelSheet({ open, onClose, providers, providerId, modelId, favorites, onToggleFavorite, onSelect, permission }: {
  open: boolean
  onClose(): void
  providers: LlmProviderOption[]
  providerId?: string
  modelId?: string
  favorites: Set<string>
  onToggleFavorite(key: string): void
  onSelect(providerId: string, modelId: string): void
  permission?: PermissionView
}) {
  const [query, setQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [rail, setRail] = useState<string>('all')

  const grouped = useMemo(() => {
    // An empty catalog is not a provider here; duplicate rows merge, as on the desktop.
    const unique = new Map<string, LlmProviderOption>()
    for (const provider of providers) {
      if (!provider.models.length) continue
      const existing = unique.get(provider.id)
      if (!existing) { unique.set(provider.id, provider); continue }
      const models = new Map(existing.models.map((model) => [model.id, model]))
      for (const model of provider.models) models.set(model.id, model)
      unique.set(provider.id, { ...existing, models: [...models.values()] })
    }
    return [...unique.values()].map((provider) => groupProviderModels(provider.id, provider.label, provider.models))
  }, [providers])

  const entries = useMemo((): FlatEntry[] => grouped.flatMap((provider) =>
    provider.families.map((family) => ({ providerId: provider.providerId, providerLabel: provider.label, family, key: `${provider.providerId}:${family.familyId}` }))), [grouped])

  const preferredEffort = modelId ? parseThinkingSuffixFromModelId(modelId).effort : undefined
  const needle = query.trim().toLowerCase()
  const visible = entries.filter((entry) => {
    if (rail !== 'all' && entry.providerId !== rail) return false
    if (favoritesOnly && !favorites.has(entry.key)) return false
    if (!needle) return true
    return [entry.family.familyLabel, entry.family.brandLabel, entry.providerLabel, ...entry.family.variants.flatMap((variant) => [variant.id, variant.label])]
      .some((text) => text.toLowerCase().includes(needle))
  })
  const selectedFamily = providerId && modelId ? findModelFamily(providerId, providers.find((provider) => provider.id === providerId)?.models ?? [], modelId) : undefined
  const selectedContext = (() => {
    if (!providerId || !modelId) return undefined
    const models = providers.find((provider) => provider.id === providerId)?.models ?? []
    const base = parseThinkingSuffixFromModelId(modelId).baseId
    const model = models.find((entry) => entry.id === modelId || entry.id === base)
    return model ? parseModelVariant(model).context : undefined
  })()

  const choose = (entry: FlatEntry, context?: string) => {
    const options = initialVariantOptions(entry.family, modelId ?? '', preferredEffort)
    const resolved = resolveModelVariant(entry.family, context ? { ...options, context } : options)
    if (resolved) onSelect(entry.providerId, resolved.id)
    onClose()
  }

  return (
    <Sheet
      open={open}
      title="Model"
      onClose={onClose}
      footer={<RunSettings providers={providers} providerId={providerId} modelId={modelId} permission={permission} onSelect={onSelect} onClose={onClose} />}
    >
      {grouped.length === 0 ? (
        <p className="m-sheet__lead">No providers connected. Connect one in Mousse on the computer.</p>
      ) : (
        <>
          <div className="m-model-search">
            <button
              type="button"
              className="m-model-search__favorites"
              aria-pressed={favoritesOnly}
              aria-label="Favorites only"
              onClick={() => setFavoritesOnly((value) => !value)}
            >
              <Star size={17} />
            </button>
            <SearchField value={query} onChange={setQuery} placeholder="Search models" />
          </div>
          {grouped.length > 1 && (
            <div className="m-chips m-model-rail" role="tablist" aria-label="Providers">
              <button type="button" role="tab" className="m-chip m-chip--icon" aria-pressed={rail === 'all'} aria-selected={rail === 'all'} onClick={() => setRail('all')}>
                <LayoutGrid size={15} /> All
              </button>
              {grouped.map((provider) => (
                <button key={provider.providerId} type="button" role="tab" className="m-chip m-chip--icon" aria-pressed={rail === provider.providerId} aria-selected={rail === provider.providerId} onClick={() => setRail(provider.providerId)}>
                  <ProviderIcon providerId={provider.providerId} size={15} /> {provider.label}
                </button>
              ))}
            </div>
          )}
          <div className="m-options" role="menu" aria-label="Models">
            {visible.length === 0 && <p className="m-sheet__lead">{favoritesOnly ? 'No favorite models yet. Tap a star to add one.' : 'No models match.'}</p>}
            {visible.map((entry) => {
              const selected = entry.providerId === providerId && selectedFamily?.familyId === entry.family.familyId
              const favorite = favorites.has(entry.key)
              return (
                <div key={entry.key} className="m-model-row">
                  <SheetOption
                    selected={selected}
                    label={`${entry.family.familyLabel}, ${entry.providerLabel}`}
                    leading={<ProviderIcon providerId={entry.family.brandId === 'anthropic' ? 'claude' : entry.family.brandId} size={20} />}
                    title={entry.family.familyLabel}
                    detail={grouped.length > 1 && entry.family.brandLabel !== entry.providerLabel ? `${entry.family.brandLabel} · ${entry.providerLabel}` : entry.family.brandLabel}
                    onClick={() => choose(entry)}
                  />
                  <button
                    type="button"
                    className="m-model-row__star"
                    aria-pressed={favorite}
                    aria-label={favorite ? `Remove ${entry.family.familyLabel} from favorites` : `Add ${entry.family.familyLabel} to favorites`}
                    onClick={() => onToggleFavorite(entry.key)}
                  >
                    <Star size={17} />
                  </button>
                  {entry.family.contexts.length > 1 && (
                    <div className="m-model-row__contexts" role="group" aria-label={`${entry.family.familyLabel} context`}>
                      <span>Context</span>
                      {entry.family.contexts.map((context) => (
                        <button
                          key={context}
                          type="button"
                          className="m-context-chip"
                          aria-pressed={selected && selectedContext === context}
                          onClick={() => choose(entry, context)}
                        >
                          {context}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Sheet>
  )
}

/** A level as the desktop names it ("Extra high"). */
export function reasoningLevelLabel(level: string): string {
  return level === 'xhigh' ? 'Extra high' : formatEffortLabel(level)
}

/** How the desktop names a permission mode. */
export const PERMISSION_META: Record<PermissionMode, { label: string; icon: ReactNode }> = {
  ask: { label: 'Ask before acting', icon: <ShieldCheck size={14} /> },
  accept_edits: { label: 'Auto-accept edits', icon: <Pencil size={14} /> },
  auto: { label: 'Auto', icon: <Wand2 size={14} /> },
  full: { label: 'Full access', icon: <ShieldOff size={14} /> },
}

/** The thread's permission mode as the composer shows it; the computer that runs the thread sets it. */
export interface PermissionView {
  mode: PermissionMode
  /** The computer's name, where the mode can be changed. */
  computer?: string
}

const PERMISSION_ORDER: readonly PermissionMode[] = ['ask', 'accept_edits', 'auto', 'full']

/**
 * The mode a turn from this phone runs in: the thread's own, else the computer's default, never more
 * than the computer lets this phone have. Undefined when the computer does not say (an older Mousse).
 */
export function shownPermission(
  options: { defaultMode: PermissionMode; limit?: PermissionMode } | undefined,
  threadMode: PermissionMode | undefined,
  computer?: string,
): PermissionView | undefined {
  if (!options) return undefined
  const wanted = threadMode ?? options.defaultMode
  const mode = options.limit && PERMISSION_ORDER.indexOf(options.limit) < PERMISSION_ORDER.indexOf(wanted) ? options.limit : wanted
  return { mode, ...(computer ? { computer } : {}) }
}

/** The model button's run settings: the reasoning level, and whether a faster speed is on (desktop runLevelText, runFasterSpeed). */
export function runSettingsOf(providers: LlmProviderOption[], providerId?: string, modelId?: string): { level?: string; fast: boolean } {
  if (!providerId || !modelId) return { fast: false }
  const models = providers.find((provider) => provider.id === providerId)?.models ?? []
  const efforts = getEffortsForModel(providerId, modelId, models)
  const fast = getModelFastToggle(providerId, modelId, models)
  const effort = efforts.length || fast ? getCurrentEffort(modelId, models, providerId) : undefined
  return { ...(effort ? { level: reasoningLevelLabel(effort) } : {}), fast: !!fast?.active }
}

/**
 * The desktop model picker's run settings at phone size, under the model list: the selected model's
 * reasoning levels, then its speed toggle on the left and the thread's permission mode on the right.
 * Picking a level or a speed picks that model and closes the sheet, as on the desktop.
 */
function RunSettings({ providers, providerId, modelId, permission, onSelect, onClose }: {
  providers: LlmProviderOption[]
  providerId?: string
  modelId?: string
  permission?: PermissionView
  onSelect(providerId: string, modelId: string): void
  onClose(): void
}) {
  const models = providers.find((provider) => provider.id === providerId)?.models ?? []
  const efforts = providerId && modelId ? getEffortsForModel(providerId, modelId, models) : []
  const effort = providerId && modelId ? getCurrentEffort(modelId, models, providerId) : undefined
  const fast = providerId && modelId ? getModelFastToggle(providerId, modelId, models) : undefined
  const model = models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.id === parseThinkingSuffixFromModelId(modelId ?? '').baseId)
  const name = model ? shortModelName(extractFamilyLabel(model.label)) : undefined
  if (!efforts.length && !fast && !permission) return null
  const select = (id: string) => { onClose(); if (providerId) onSelect(providerId, id) }
  const selectEffort = (value: string) => {
    if (!providerId || !modelId || value === effort) { onClose(); return }
    const family = findModelFamily(providerId, models, modelId)
    const variant = model ? parseModelVariant(model) : undefined
    const resolved = family && resolveModelVariant(family, { context: variant?.context, speed: variant?.speed, effort: value })
    select(value === 'off'
      ? `${parseThinkingSuffixFromModelId(resolved?.id ?? modelId).baseId}:off`
      : resolved?.id ?? applyEffortToModelId(modelId, value))
  }
  const permissionMeta = permission ? PERMISSION_META[permission.mode] : undefined
  return (
    <div className="m-run-settings">
      {efforts.length > 0 && (
        <div className="m-run-settings__reasoning" role="radiogroup" aria-label={name ? `Reasoning for ${name}` : 'Reasoning'}>
          <div className="m-run-settings__head">
            <span>Reasoning</span>
            {name && <span className="m-run-settings__model">{name}</span>}
          </div>
          <div className="m-run-levels">
            {['off', ...efforts.filter((value) => value !== 'off')].map((value) => (
              <button key={value} type="button" role="radio" aria-checked={effort === value} className="m-run-level" onClick={() => selectEffort(value)}>
                {reasoningLevelLabel(value)}
              </button>
            ))}
          </div>
        </div>
      )}
      {(fast || permissionMeta) && (
        <div className="m-run-settings__foot">
          {fast ? (
            <div className="m-speed" role="radiogroup" aria-label="Speed">
              {[false, true].map((enabled) => (
                <button
                  key={String(enabled)}
                  type="button"
                  role="radio"
                  aria-checked={fast.active === enabled}
                  className="m-speed__option"
                  onClick={() => {
                    if (fast.active === enabled) { onClose(); return }
                    select(effort === 'off' ? `${parseThinkingSuffixFromModelId(fast.targetModelId).baseId}:off` : fast.targetModelId)
                  }}
                >
                  {enabled && <Zap size={13} />}
                  <span>{enabled ? 'Fast' : 'Standard'}</span>
                </button>
              ))}
            </div>
          ) : <span />}
          {permission && permissionMeta && (
            <span
              className="m-run-permission"
              role="note"
              aria-label={`Permission mode: ${permissionMeta.label}`}
              title={permission.computer ? `Change it in Mousse on ${permission.computer}` : undefined}
            >
              {permissionMeta.icon}
              <span>{permissionMeta.label}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function SkillSheet({ open, onClose, skills, initialQuery = '', onSelect }: {
  open: boolean
  onClose(): void
  skills: ComposerSkill[]
  initialQuery?: string
  onSelect(skill: ComposerSkill): void
}) {
  const [query, setQuery] = useState(initialQuery)
  const needle = query.trim().toLowerCase()
  const visible = skills.filter((skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
  return (
    <Sheet open={open} title="Skills" onClose={onClose}>
      {skills.length === 0 ? (
        <p className="m-sheet__lead">No skills are enabled on this computer.</p>
      ) : (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Search skills" />
          <div className="m-options" role="menu" aria-label="Skills">
            {visible.length === 0 && <p className="m-sheet__lead">No skills match.</p>}
            {visible.map((skill) => (
              <SheetOption key={skill.id} leading={<Sparkles size={16} />} title={skill.name} detail={skill.description} onClick={() => { onSelect(skill); onClose() }} />
            ))}
          </div>
        </>
      )}
    </Sheet>
  )
}

const tokens = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value)

export function ContextRing({ usage, onClick }: { usage: ContextUsage; onClick(): void }) {
  const percent = Math.max(0, Math.min(100, usage.percent))
  const circumference = 2 * Math.PI * 9
  return (
    <button type="button" className="m-composer__icon" aria-label={`Context ${Math.round(percent)}% used`} onClick={onClick}>
      <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden className="m-context-ring">
        <circle cx="11" cy="11" r="9" className="m-context-ring__track" />
        <circle cx="11" cy="11" r="9" className="m-context-ring__value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} />
      </svg>
    </button>
  )
}

export function ContextSheet({ open, onClose, usage }: { open: boolean; onClose(): void; usage?: ContextUsage }) {
  const total = usage?.categories.reduce((sum, row) => sum + row.tokens, 0) ?? 0
  return (
    <Sheet open={open} title="Context" onClose={onClose}>
      {usage && (
        <div className="m-context">
          <div className="m-context__head">
            <strong>{Math.round(usage.percent)}%</strong>
            <span>~{tokens(usage.used)} / {tokens(usage.limit)} tokens</span>
          </div>
          {usage.modelName && <p className="m-sheet__lead">{usage.modelName}</p>}
          {total > 0 && (
            <>
              <div className="m-context__bar" aria-hidden>
                {usage.categories.map((row) => <span key={row.label} style={{ flexGrow: row.tokens, background: row.color }} />)}
                <span style={{ flexGrow: Math.max(0, usage.limit - total), background: 'transparent' }} />
              </div>
              <ul className="m-context__list">
                {usage.categories.map((row) => (
                  <li key={row.label}><span className="m-context__swatch" style={{ background: row.color }} />{row.label}<span>{tokens(row.tokens)}</span></li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Sheet>
  )
}

export function QueueItemSheet({ item, onClose, canSteer, isFirst, isLast, onSteer, onEdit, onMove, onRemove }: {
  item?: QueuedMessage
  onClose(): void
  canSteer: boolean
  isFirst: boolean
  isLast: boolean
  onSteer(item: QueuedMessage): void
  onEdit(item: QueuedMessage): void
  onMove(item: QueuedMessage, delta: -1 | 1): void
  onRemove(item: QueuedMessage): void
}) {
  const run = (action: (item: QueuedMessage) => void) => () => { if (item) action(item); onClose() }
  return (
    <Sheet open={!!item} title="Queued message" onClose={onClose}>
      {item && (
        <div className="m-options" role="menu" aria-label="Queued message">
          <p className="m-queue-preview">{item.content}</p>
          {canSteer && <SheetOption leading={<Steer size={16} />} title="Steer into the current turn" onClick={run(onSteer)} />}
          <SheetOption leading={<Pencil size={16} />} title="Edit" detail="Moves it back to the composer" onClick={run(onEdit)} />
          {!isFirst && <SheetOption leading={<ArrowUp size={16} />} title="Move up" onClick={run((entry) => onMove(entry, -1))} />}
          {!isLast && <SheetOption leading={<ArrowDown size={16} />} title="Move down" onClick={run((entry) => onMove(entry, 1))} />}
          <SheetOption leading={<Copy size={16} />} title="Copy text" onClick={run((entry) => { void navigator.clipboard?.writeText(entry.content).catch(() => undefined) })} />
          <SheetOption leading={<Trash2 size={16} />} title="Remove" onClick={run(onRemove)} />
        </div>
      )}
    </Sheet>
  )
}
