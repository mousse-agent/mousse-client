import { useState, type FormEvent } from 'react'
import { useConnection } from '../hooks/connection'
import { errorMessage } from '../hooks/useAsync'
import { Button, Field, MousseLogo, Notice } from '../components/primitives'
import { Lock, Mail } from '../components/icons'

type Pending = 'password' | 'google'

/** The Google "G" mark in its brand colors. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

export function SignInScreen() {
  const connection = useConnection()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<Pending>()
  const [error, setError] = useState<string>()

  async function run(kind: Pending, action: () => Promise<void>) {
    setPending(kind)
    setError(undefined)
    try { await action() } catch (cause) { setError(errorMessage(cause)) } finally { setPending(undefined) }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void run('password', () => connection.signInWithPassword(email.trim(), password))
  }

  return (
    <main className="m-screen m-signin">
      <div className="m-signin__panel">
        <div className="m-signin__brand">
          <MousseLogo size={30} />
          <h1>Sign in to Mousse</h1>
          <p>Use your Mousse ID to reach the computers on your account.</p>
        </div>

        <Button block icon={<GoogleMark />} busy={pending === 'google'} disabled={!!pending}
          onClick={() => void run('google', () => connection.signInWithGoogle())}>
          Continue with Google
        </Button>

        <div className="m-divider" role="separator"><span>or</span></div>

        <form className="m-form" onSubmit={onSubmit} noValidate>
          <Field label="Email">
            <div className="m-input-wrap">
              <Mail size={17} />
              <input
                className="m-input"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </Field>

          <Field label="Password">
            <div className="m-input-wrap">
              <Lock size={17} />
              <input
                className="m-input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </Field>

          {error && <Notice>{error}</Notice>}

          <Button type="submit" variant="primary" block busy={pending === 'password'}
            disabled={!email.trim() || !password || pending === 'google'}>
            Sign in
          </Button>
        </form>

        <div className="m-signin__footer">
          <span>New to Mousse?</span>
          <Button variant="ghost" onClick={() => void connection.openSignUp()}>Create account</Button>
        </div>
      </div>
    </main>
  )
}
