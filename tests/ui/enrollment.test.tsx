import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { FakeMousseConnection } from '../../src/ui/dev/fakeConnection'
import { installMatchMedia, renderApp } from './helpers'

beforeEach(() => installMatchMedia())

const fake = (connection: unknown) => connection as FakeMousseConnection

describe('joining the computers on its own', () => {
  it('adds a signed-in phone through the computer that adds devices, with one quiet line and no code', async () => {
    const { connection } = renderApp({ signedIn: true, phoneJoined: false, stageDelayMs: 40 })
    expect(await screen.findByText('Adding this phone to your computers…')).toBeInTheDocument()
    expect(screen.queryByTestId('match-code')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add this phone/ })).not.toBeInTheDocument()

    // Once joined, the computers' threads simply appear.
    expect(await screen.findByText('Phone app redesign', {}, { timeout: 3000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Adding this phone to your computers…')).not.toBeInTheDocument())
    expect(fake(connection).enrollRequests).toEqual(['node-studio'])
  })

  it('never asks again once the phone is among the computers', async () => {
    const { connection } = renderApp({ signedIn: true })
    expect(await screen.findByText('Phone app redesign')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake(connection).enrollRequests).toEqual([])
    expect(screen.queryByText(/Adding this phone/)).not.toBeInTheDocument()
  })

  it('says what to do while the computer is offline, and joins once it is back', async () => {
    const { connection } = renderApp({ signedIn: true, phoneJoined: false, joinOptions: { retryMs: [40] } })
    fake(connection).setOnline('node-studio', false)
    expect(await screen.findByText('Open Mousse on Studio Mac to finish adding this phone.')).toBeInTheDocument()
    expect(fake(connection).enrollRequests).toEqual([])

    fake(connection).setOnline('node-studio', true)
    await waitFor(() => expect(fake(connection).enrollRequests).toEqual(['node-studio']), { timeout: 2000 })
    await waitFor(() => expect(screen.queryByText(/finish adding this phone/)).not.toBeInTheDocument(), { timeout: 2000 })
  })

  it('stays out after the computers removed it, until the user adds it again in Settings', async () => {
    const { connection } = renderApp({ signedIn: true, phoneJoined: false, routes: [{ name: 'home' }, { name: 'settings' }] })
    fake(connection).removed = true
    const again = await screen.findByRole('button', { name: 'Add this phone again' })
    expect(fake(connection).enrollRequests).toEqual([])
    fireEvent.click(again)
    await waitFor(() => expect(fake(connection).enrollRequests).toEqual(['node-studio']), { timeout: 2000 })
  })
})

describe('devices in Settings', () => {
  it('lists the computers and phones with their state', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'settings' }] })
    const computers = await screen.findByLabelText('Computers')
    expect(within(computers).getByText('Studio Mac')).toBeInTheDocument()
    expect(within(computers).getByText('Offline · seen 3 days ago')).toBeInTheDocument()
    expect(within(computers).getByText('Online · not added')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Phones')).getByText('Pixel 9')).toBeInTheDocument()
  })

  it('keeps the QR code as a fallback and reports a pairing link that is not a Mousse link', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'settings' }] })
    fireEvent.click(await screen.findByRole('button', { name: 'Add with a QR code' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add with a QR code' })
    fireEvent.change(within(dialog).getByLabelText(/Pairing link/), { target: { value: 'https://example.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not a Mousse pairing code')
  })
})
