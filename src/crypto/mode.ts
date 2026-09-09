/** Wire / discovery / QR / prologue mode strings. */
export const WIRE_CONTROL_MODES = ['hosted', 'self-hosted'] as const
export type WireControlMode = (typeof WIRE_CONTROL_MODES)[number]

/**
 * Storage / SQL installation mode strings.
 * DB check constraints use underscore; wire always uses hyphenated `self-hosted`.
 */
export const STORAGE_CONTROL_MODES = ['hosted', 'self_hosted'] as const
export type StorageControlMode = (typeof STORAGE_CONTROL_MODES)[number]

export function wireModeFromStorage(mode: StorageControlMode | string): WireControlMode {
  return mode === 'self_hosted' ? 'self-hosted' : 'hosted'
}

export function storageModeFromWire(mode: WireControlMode | string): StorageControlMode {
  return mode === 'self-hosted' ? 'self_hosted' : 'hosted'
}

export function isWireControlMode(value: unknown): value is WireControlMode {
  return typeof value === 'string' && WIRE_CONTROL_MODES.includes(value as WireControlMode)
}
