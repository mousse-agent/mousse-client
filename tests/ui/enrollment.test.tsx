import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'

beforeEach(() => installMatchMedia())

describe('add this phone', () => {
  it('walks through the enrollment stages and shows the match code', async () => {
    renderApp({ signedIn: true, stageDelayMs: 40 })
    fireEvent.click(await screen.findByText('Linux workstation'))
    const dialog = await screen.findByRole('dialog', { name: 'Add this phone to Linux workstation' })
    fireEvent.change(within(dialog).getByLabelText('Name this phone'), { target: { value: 'Test phone' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }))

    await waitFor(() => expect(within(dialog).getByText('Asking the computer').closest('li')).toHaveAttribute('data-state', 'current'))
    const code = await within(dialog).findByTestId('match-code')
    expect(code).toHaveTextContent('482 913')
    expect(within(dialog).getByText('Approve on Linux workstation').closest('li')).toHaveAttribute('aria-current', 'step')
    // The sheet cannot be dismissed while the computer is deciding.
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

    await waitFor(() => expect(within(dialog).getByText('Connecting securely').closest('li')).toHaveAttribute('data-state', 'current'))
    expect(await within(dialog).findByRole('button', { name: 'Open Linux workstation' }, { timeout: 2000 })).toBeInTheDocument()
    expect(within(dialog).queryByTestId('match-code')).not.toBeInTheDocument()
  })

  it('reports a pairing link that is not a Mousse link', async () => {
    renderApp({ signedIn: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Scan QR code' }))
    const dialog = await screen.findByRole('dialog', { name: 'Scan QR code' })
    fireEvent.change(within(dialog).getByLabelText(/Pairing link/), { target: { value: 'https://example.com' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not a Mousse pairing code')
  })
})
