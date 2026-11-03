import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { createFakeConnection } from '../../src/ui/dev/fakeConnection'
import type { ComputerSession } from '../../src/connection/types'
import { installMatchMedia } from './helpers'

beforeEach(() => installMatchMedia())

describe('lost connection', () => {
  it('says why the session to the computer closed', async () => {
    const connection = createFakeConnection({ signedIn: true, latencyMs: 0, stageDelayMs: 15, tickMs: 5 })
    const opened: ComputerSession[] = []
    const open = connection.openComputer.bind(connection)
    connection.openComputer = async (nodeId) => {
      const session = await open(nodeId)
      opened.push(session)
      return session
    }
    render(<App connection={connection} initialRoutes={[{ name: 'home' }, { name: 'thread', nodeId: 'node-studio', threadId: 't-voices' }]} />)
    await screen.findByLabelText('Message')
    act(() => (opened[0] as ComputerSession & { close(message?: string): void }).close('The relay closed the connection (code 1008).'))
    expect(await screen.findByText(/^Lost the connection to .+: The relay closed the connection \(code 1008\)\.$/)).toBeInTheDocument()
  })
})
