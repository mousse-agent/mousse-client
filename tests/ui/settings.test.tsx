import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { FAKE_ID_ORIGIN } from '../../src/ui/dev/fakeConnection'
import { installMatchMedia, renderApp } from './helpers'

describe('settings', () => {
  beforeEach(() => installMatchMedia())

  it('shows the Mousse ID, device usage and the Mousse ID server, with no plan', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'computers' }, { name: 'settings' }] })

    expect(screen.getByText('demo@mousse.dev')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('device-usage')).toHaveTextContent('4 of 5 devices'))
    expect(screen.queryByText(/plan|upgrade|pricing|plus/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByText('Mousse ID server')).toBeInTheDocument()
    expect(screen.getByText(FAKE_ID_ORIGIN)).toBeInTheDocument()
  })

  it('handles a Mousse ID without an email', async () => {
    renderApp({ signedIn: true, email: null, routes: [{ name: 'computers' }, { name: 'settings' }] })

    expect(screen.getByText('Signed in, no email on file')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('device-usage')).toHaveTextContent('of 5 devices'))
  })
})
