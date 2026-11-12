import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { FAKE_ID_ORIGIN } from '../../src/ui/dev/fakeConnection'
import { installMatchMedia, renderApp } from './helpers'

describe('settings', () => {
  beforeEach(() => installMatchMedia())

  it('shows the Mousse ID, device usage and the Mousse ID server, with no plan', async () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'settings' }] })

    expect(screen.getByText('demo@mousse.dev')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('device-usage')).toHaveTextContent('4 of 5 devices'))
    expect(screen.queryByText(/plan|upgrade|pricing|plus/i)).not.toBeInTheDocument()

    // Advanced is a closed fold at the end of the page, like the desktop's settings pages.
    const advanced = screen.getByRole('button', { name: 'Advanced' })
    expect(advanced).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Mousse ID server')).not.toBeInTheDocument()
    fireEvent.click(advanced)
    expect(advanced).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Mousse ID server')).toBeInTheDocument()
    expect(screen.getByText(FAKE_ID_ORIGIN)).toBeInTheDocument()
  })

  it('groups the page under headings, with the theme and accent under Colors', () => {
    renderApp({ signedIn: true, routes: [{ name: 'home' }, { name: 'settings' }] })

    for (const name of ['Account', 'Devices', 'Colors', 'About']) expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    const colors = screen.getByRole('region', { name: 'Colors' })
    expect(within(colors).getByRole('tablist', { name: 'Color theme' })).toBeInTheDocument()
    const accents = within(colors).getByRole('radiogroup', { name: 'Accent color' })
    fireEvent.click(within(accents).getByRole('radio', { name: 'Teal' }))
    expect(within(accents).getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true')
  })

  it('handles a Mousse ID without an email', async () => {
    renderApp({ signedIn: true, email: null, routes: [{ name: 'home' }, { name: 'settings' }] })

    expect(screen.getByText('Signed in, no email on file')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('device-usage')).toHaveTextContent('of 5 devices'))
  })
})
