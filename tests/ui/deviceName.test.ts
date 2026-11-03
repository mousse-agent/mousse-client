import { describe, expect, it } from 'vitest'
import { defaultDeviceName } from '../../src/ui/lib/deviceName'

describe('the name a phone joins with', () => {
  it('is the model the browser reports, or a plain name when it hides it', () => {
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36')).toBe('Pixel 8')
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Android phone')
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone')
    expect(defaultDeviceName('')).toBe('Phone')
  })
})
