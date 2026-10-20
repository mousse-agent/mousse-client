/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" to run the UI against src/ui/dev/fakeConnection.ts. */
  readonly VITE_FAKE_CONNECTION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string
