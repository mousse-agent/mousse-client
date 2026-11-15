import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Sidebar } from '../../src/ui/sidebar/Sidebar'
import type { ComputerLists } from '../../src/connection/types'

// Only the observers the test fires report an element on screen.
const observers: { callback: IntersectionObserverCallback; nodes: Element[] }[] = []
class FakeObserver {
  nodes: Element[] = []
  constructor(public callback: IntersectionObserverCallback) { observers.push(this) }
  observe(node: Element) { this.nodes.push(node) }
  disconnect() { this.nodes = [] }
  unobserve() {}
  takeRecords() { return [] }
}

afterEach(() => {
  vi.unstubAllGlobals()
  observers.length = 0
})

describe('Chats tab', () => {
  it('draws Recent 30 rows at a time, adding more as the reader nears the end', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const lists: ComputerLists = {
      projects: [],
      threads: [],
      chats: Array.from({ length: 70 }, (_, index) => ({ id: `c${index}`, kind: 'direct' as const, name: `Chat ${index}`, threadId: `t${index}`, network: false, agents: ['A'], updatedAt: 1000 - index })),
      bots: [],
      status: {},
      receivedAt: 0,
    }
    render(<Sidebar lists={lists} tab="chats" onOpenThread={() => {}} onOpenChat={() => {}} onNewThread={() => {}} />)
    expect(screen.getAllByText(/^Chat \d+$/)).toHaveLength(30)
    const more = () => {
      const sentinel = document.querySelector('.m-sb-more')!
      const observer = observers.find((entry) => entry.nodes.includes(sentinel))!
      act(() => observer.callback([{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry], observer as unknown as IntersectionObserver))
    }
    more()
    expect(screen.getAllByText(/^Chat \d+$/)).toHaveLength(60)
    more()
    expect(screen.getAllByText(/^Chat \d+$/)).toHaveLength(70)
    expect(document.querySelector('.m-sb-more')).toBeNull()
  })
})
