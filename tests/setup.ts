import '@testing-library/jest-dom/vitest'

if (typeof window !== 'undefined') {
  if (!window.crypto || !window.crypto.subtle) {
    Object.defineProperty(window, 'crypto', {
      value: globalThis.crypto,
      writable: true,
      configurable: true
    })
  }
  if (!window.WebSocket && typeof globalThis.WebSocket !== 'undefined') {
    Object.defineProperty(window, 'WebSocket', {
      value: globalThis.WebSocket,
      writable: true,
      configurable: true
    })
  }
}
