interface ImportMetaEnv {
  /** Mousse ID API origin, for example `https://id.example`. Read only through src/mousseId/origin.ts. */
  readonly VITE_MOUSSE_ID_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
