import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ErrorBoundary } from '../../src/ui/components/ErrorBoundary'
import './helpers'

function Boom({ fail }: { fail: boolean }): JSX.Element {
  if (fail) throw new Error('lists.bots is undefined')
  return <p>Fine</p>
}

function Harness() {
  const [fail, setFail] = useState(true)
  return <><button onClick={() => setFail(false)}>Fix</button><ErrorBoundary what="the Chats tab"><Boom fail={fail} /></ErrorBoundary></>
}

describe('ErrorBoundary', () => {
  it('shows what failed instead of taking the app down, and Try again renders it again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Harness />)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in the Chats tab.')
    expect(screen.getByText('lists.bots is undefined')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Fix'))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('Fine')).toBeInTheDocument()
  })
})
