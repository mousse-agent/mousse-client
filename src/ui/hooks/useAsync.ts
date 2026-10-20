import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  reload(): void
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Something went wrong. Try again.'
}

/** Runs `load` when its dependencies change; ignores results from stale runs. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const run = useRef(0)

  useEffect(() => {
    const id = ++run.current
    setLoading(true)
    setError(undefined)
    load().then(
      (value) => { if (run.current === id) { setData(value); setLoading(false) } },
      (cause) => { if (run.current === id) { setError(errorMessage(cause)); setLoading(false) } }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  useEffect(() => () => { run.current++ }, [])
  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { data, error, loading, reload }
}
