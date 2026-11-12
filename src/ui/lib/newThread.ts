import type { Computer, ListProject, LlmProviderOption, ModelSelection } from '../../connection/types'
import { parseThinkingSuffixFromModelId } from './modelVariants'

/** Computers that can run a thread from this phone: the account's computers this phone was added to. */
export function threadComputers(computers: readonly Computer[]): Computer[] {
  return computers.filter((computer) => computer.kind === 'computer' && computer.enrolled)
}

/**
 * Where a new thread starts, like the desktop composer's computer menu: the computer last used,
 * else the one that adds devices (the authority), else the first one online, else the first one.
 */
export function defaultComputer(computers: readonly Computer[], lastUsed?: string): Computer | undefined {
  const usable = threadComputers(computers)
  return (
    usable.find((computer) => computer.nodeId === lastUsed) ??
    usable.find((computer) => computer.authority) ??
    usable.find((computer) => computer.online) ??
    usable[0]
  )
}

/** The project a new thread goes to: the one asked for, else the last used, else the computer's first. '' is no project. */
export function defaultProject(projects: readonly ListProject[], wanted?: string, lastUsed?: string): string {
  if (wanted !== undefined && (wanted === '' || projects.some((project) => project.id === wanted))) return wanted
  if (lastUsed !== undefined && (lastUsed === '' || projects.some((project) => project.id === lastUsed))) return lastUsed
  return sortedProjects(projects)[0]?.id ?? ''
}

/** The computer's projects in its sidebar order. */
export function sortedProjects(projects: readonly ListProject[]): ListProject[] {
  return [...projects].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Whether the computer's model picker still offers `model`; a remembered model it no longer offers is not used. */
export function offersModel(providers: readonly LlmProviderOption[], model: ModelSelection): boolean {
  const provider = providers.find((entry) => (model.instanceId && entry.instanceId ? entry.instanceId === model.instanceId : entry.id === model.llmProvider))
  if (!provider) return false
  const base = parseThinkingSuffixFromModelId(model.model).baseId
  return provider.models.some((entry) => entry.id === model.model || parseThinkingSuffixFromModelId(entry.id).baseId === base)
}
