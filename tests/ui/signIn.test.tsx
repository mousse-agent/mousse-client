import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { installMatchMedia, renderApp } from './helpers'

beforeEach(() => installMatchMedia())

describe('sign in', () => {
  it('signs in with email and password and shows the threads', async () => {
    renderApp()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Threads' })).toBeInTheDocument()
    expect(await screen.findByText('Phone app redesign')).toBeInTheDocument()
  })

  it('shows the error when the password is rejected', async () => {
    renderApp()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match')
    expect(screen.queryByRole('heading', { name: 'Threads' })).not.toBeInTheDocument()
  })

  it('offers only Google and password sign-in', () => {
    renderApp()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText(/email code/i)).not.toBeInTheDocument()
    const google = screen.getByRole('button', { name: 'Continue with Google' })
    const separator = screen.getByRole('separator')
    // Google comes first, then the "or" divider, then the password form.
    expect(google.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(separator.compareDocumentPosition(screen.getByLabelText('Password')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('signs in with Google and shows the threads', async () => {
    const { connection } = renderApp()
    const signInWithGoogle = vi.spyOn(connection, 'signInWithGoogle')
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(signInWithGoogle).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('heading', { name: 'Threads' })).toBeInTheDocument()
  })

  it('shows a notice and stays on sign-in when Google sign-in is cancelled', async () => {
    renderApp({ googleSignIn: 'cancelled' })
    const google = screen.getByRole('button', { name: 'Continue with Google' })
    fireEvent.click(google)
    expect(google).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled')
    await waitFor(() => expect(google).not.toHaveAttribute('aria-busy'))
    expect(screen.queryByRole('heading', { name: 'Threads' })).not.toBeInTheDocument()
  })

  it('shows the error when Google sign-in fails', async () => {
    renderApp({ googleSignIn: 'failed' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('did not finish')
  })

  it('opens sign-up from Create account', () => {
    const { connection } = renderApp()
    const openSignUp = vi.spyOn(connection, 'openSignUp').mockResolvedValue()
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(openSignUp).toHaveBeenCalledTimes(1)
  })
})
