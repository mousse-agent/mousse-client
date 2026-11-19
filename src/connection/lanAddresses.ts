// The LAN addresses each computer reported in its answer to `net.direct.endpoints`, kept between
// app starts so the phone can try the computer on its own network before the relay even when no
// advertisement has arrived yet (multicast blocked on the Wi-Fi, or the app just started). Like an
// advertisement, an address only says where to try: the computer's pinned key and the session's
// roster checks authenticate it. Addresses are never logged or shown.
import { readJson, writeJson, type KeyStorage } from '../net/keys'
import type { LanHint } from '../net/lan'

const KEY = 'net.lanAddresses'
/** Addresses unconfirmed for this long are forgotten. */
export const LAN_ADDRESSES_TTL_MS = 30 * 24 * 60 * 60_000
/** Computers kept; the oldest go first. */
const COMPUTERS_MAX = 64
const ADDRESSES_MAX = 8

interface Row {
  /** The computer's transport key (base64url SPKI) the addresses were reported under. */
  transport: string
  addresses: LanHint[]
  savedAt: number
}

type Book = Record<string, Row>

function validHint(value: unknown): value is LanHint {
  const hint = value as LanHint | null
  return typeof hint?.host === 'string' && hint.host.length <= 64 && Number.isInteger(hint.port) && hint.port > 0 && hint.port < 65536
}

const same = (a: LanHint, b: LanHint) => a.host === b.host && a.port === b.port

export class LanAddresses {
  /** Changes run one after another, so two sessions never overwrite each other's update. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: KeyStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** The addresses `node` reported under `transport` within the last 30 days; empty otherwise. */
  async read(node: string, transport: string): Promise<LanHint[]> {
    const row = (await this.load())[node]
    if (!row || row.transport !== transport || this.now() - row.savedAt > LAN_ADDRESSES_TTL_MS) return []
    return row.addresses
  }

  /**
   * Replaces what `node` reported before with `addresses`, the computer's current list. Resolves
   * true when the list has an address the phone did not have, which is worth trying at once.
   */
  learn(node: string, transport: string, addresses: LanHint[]): Promise<boolean> {
    return this.change((book) => {
      const prior = book[node]?.transport === transport ? book[node].addresses : []
      const fresh = addresses.slice(0, ADDRESSES_MAX).map(({ host, port }) => ({ host, port }))
      if (fresh.length) book[node] = { transport, addresses: fresh, savedAt: this.now() }
      else delete book[node]
      return fresh.some((hint) => !prior.some((old) => same(old, hint)))
    })
  }

  /** Forgets one address of `node`: something else answered there with another key. */
  drop(node: string, transport: string, hint: LanHint): Promise<boolean> {
    return this.change((book) => {
      const row = book[node]
      if (!row || row.transport !== transport) return false
      row.addresses = row.addresses.filter((old) => !same(old, hint))
      if (!row.addresses.length) delete book[node]
      return true
    })
  }

  /** Forgets every address of `node`, as when the phone no longer reaches it. */
  forget(node: string): Promise<boolean> {
    return this.change((book) => {
      if (!book[node]) return false
      delete book[node]
      return true
    })
  }

  private change(edit: (book: Book) => boolean): Promise<boolean> {
    const run = this.queue.then(async () => {
      const book = await this.load()
      const result = edit(book)
      const now = this.now()
      const rows = Object.entries(book)
        .filter(([, row]) => now - row.savedAt <= LAN_ADDRESSES_TTL_MS)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, COMPUTERS_MAX)
      // Storage that cannot be written only costs the next start its head start on the LAN.
      await writeJson(this.storage, KEY, Object.fromEntries(rows)).catch(() => undefined)
      return result
    })
    this.queue = run.catch(() => undefined)
    return run.catch(() => false)
  }

  private async load(): Promise<Book> {
    const value = await readJson<unknown>(this.storage, KEY).catch(() => undefined)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const book: Book = {}
    for (const [node, row] of Object.entries(value as Record<string, unknown>)) {
      const r = row as Partial<Row> | null
      if (typeof r?.transport !== 'string' || typeof r.savedAt !== 'number' || !Array.isArray(r.addresses)) continue
      const addresses = r.addresses.filter(validHint).slice(0, ADDRESSES_MAX)
      if (addresses.length) book[node] = { transport: r.transport, addresses, savedAt: r.savedAt }
    }
    return book
  }
}
