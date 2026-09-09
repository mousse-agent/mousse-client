import { ERROR_CODES } from '../constants'
import { canonicalOrigin } from '../security'

export type MousseControlWellKnown = {
  mode: 'hosted' | 'self-hosted'
  protocol_range: { min_major: number; max_major: number }
  installation_id: string
  installation_public_key: string
  endpoints: {
    relay: string
    admissions: string
    claim: string
  }
}

export type PairingClaimResponse = {
  claimId: string
  status: 'claimed' | 'pending' | 'approved'
  leaseExpiresAt: number
  admissionToken?: string
  relayUrl?: string
}

export type RelayAdmissionResponse = {
  admissionToken: string
  relayUrl: string
  leaseExpiresAt: number
}

export class PlusApiClient {
  /**
   * Discovers server mode, installation identity, and protocol range.
   */
  async getWellKnown(controlOrigin: string): Promise<MousseControlWellKnown> {
    const origin = canonicalOrigin(controlOrigin)
    const url = `${origin}/.well-known/mousse-control`
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) {
      throw new Error(`Control server discovery failed (${res.status})`)
    }
    return (await res.json()) as MousseControlWellKnown
  }

  /**
   * Claims a pending pairing attempt on the Control Server.
   * Hosted mode sends user bearer token.
   * Self-hosted mode sends pairingSecretProof.
   */
  async claimPairingAttempt(
    controlOrigin: string,
    pairingId: string,
    options: {
      token?: string
      mobileDeviceId: string
      mobilePublicKey: string
      mobileName?: string
      pairingSecretProof?: string
    }
  ): Promise<PairingClaimResponse> {
    const origin = canonicalOrigin(controlOrigin)
    const url = `${origin}/v1/pairing-attempts/${encodeURIComponent(pairingId)}/claim`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: options.mobileDeviceId,
        publicKey: options.mobilePublicKey,
        deviceName: options.mobileName || 'Mobile Client',
        secretProof: options.pairingSecretProof
      })
    })

    if (res.status === 401) {
      throw new Error('Authentication required to claim pairing attempt.')
    }
    if (res.status === 404 || res.status === 410) {
      throw new Error('This pairing attempt does not exist or has expired.')
    }
    if (res.status === 409) {
      throw new Error('Pairing attempt already claimed or state conflict.')
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || `Claim failed (${res.status})`)
    }

    return (await res.json()) as PairingClaimResponse
  }

  /**
   * Requests a short-lived relay socket admission credential.
   */
  async getRelayAdmission(
    controlOrigin: string,
    pairingId: string,
    options: {
      token?: string
      mobileDeviceId: string
      role?: 'client'
    }
  ): Promise<RelayAdmissionResponse> {
    const origin = canonicalOrigin(controlOrigin)
    const url = `${origin}/v1/relay/admissions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        pairingId,
        deviceId: options.mobileDeviceId,
        role: options.role || 'client'
      })
    })

    if (res.status === 401) {
      throw new Error('Unauthorized relay admission request.')
    }
    if (res.status === 403) {
      throw new Error(`${ERROR_CODES.DEVICE_REVOKED}: Access has been revoked.`)
    }
    if (!res.ok) {
      throw new Error(`Relay admission failed (${res.status})`)
    }

    return (await res.json()) as RelayAdmissionResponse
  }

  /**
   * Revokes a pairing on the Control Server.
   */
  async revokePairing(
    controlOrigin: string,
    pairingId: string,
    token?: string
  ): Promise<void> {
    const origin = canonicalOrigin(controlOrigin)
    const url = `${origin}/v1/pairings/${encodeURIComponent(pairingId)}/revoke`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pairingId })
    })

    if (!res.ok && res.status !== 404) {
      throw new Error(`Revocation failed (${res.status})`)
    }
  }

  /**
   * Gets account profile summary in hosted mode.
   */
  async getMe(controlOrigin: string, token: string): Promise<Record<string, unknown>> {
    const origin = canonicalOrigin(controlOrigin)
    const url = `${origin}/v1/me`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    })
    if (!res.ok) throw new Error(`Failed to load profile (${res.status})`)
    return (await res.json()) as Record<string, unknown>
  }

  /**
   * Gets devices list in hosted mode.
   */
  async getDevices(controlOrigin: string, token: string): Promise<Record<string, unknown>[]> {
    const origin = canonicalOrigin(controlOrigin)
    const url = `${origin}/v1/devices`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    })
    if (!res.ok) throw new Error(`Failed to load devices (${res.status})`)
    const data = (await res.json()) as { devices?: Record<string, unknown>[] }
    return Array.isArray(data) ? data : data.devices || []
  }
}

export const plusApi = new PlusApiClient()
