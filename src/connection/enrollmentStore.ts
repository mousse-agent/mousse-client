// What the phone keeps after joining a user's computers: the enrollment (roster, delegation),
// the phone's node keys and its Mousse ID registration. Stored in the platform keychain.
import type { RegistrationGrant } from '../mousseId/net'
import type { Signed } from '../net/crypto'
import type { Enrollment } from '../net/enrollment'
import { currentNode, rosterPosition, verifyRoster, type Roster } from '../net/identity'
import { deserializeNodeKeys, readJson, writeJson, type KeyStorage, type NodeKeys, type StoredNodeKeys } from '../net/keys'

const STORAGE_KEY = 'net.enrollments'

export interface StoredEnrollment {
  /** The Mousse ID account the phone registered with for this enrollment. */
  accountId: string
  enrollment: Enrollment
  keys: StoredNodeKeys
  grant?: RegistrationGrant
}

/** A stored enrollment with its keys and roster checked. */
export interface LoadedEnrollment {
  stored: StoredEnrollment
  keys: NodeKeys
  roster: Roster
}

function isStored(value: unknown): value is StoredEnrollment {
  const entry = value as StoredEnrollment
  return (
    !!entry &&
    typeof entry.accountId === 'string' &&
    !!entry.enrollment &&
    typeof entry.enrollment.node === 'string' &&
    typeof entry.enrollment.user === 'string' &&
    !!entry.keys
  )
}

export class EnrollmentStore {
  private entries?: StoredEnrollment[]
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly storage: KeyStorage) {}

  async list(): Promise<StoredEnrollment[]> {
    if (!this.entries) {
      let value: unknown
      try {
        value = await readJson<unknown>(this.storage, STORAGE_KEY)
      } catch {
        value = undefined
      }
      this.entries = Array.isArray(value) ? value.filter(isStored) : []
    }
    return this.entries
  }

  /** Enrollments of one account whose keys and roster still verify. */
  async loaded(accountId: string): Promise<LoadedEnrollment[]> {
    const out: LoadedEnrollment[] = []
    for (const stored of await this.list()) {
      if (stored.accountId !== accountId) continue
      try {
        const roster = verifyRoster(stored.enrollment.roster, stored.enrollment.rootKey)
        if (roster.owner !== stored.enrollment.user) continue
        out.push({ stored, keys: deserializeNodeKeys(stored.keys), roster })
      } catch {
        // A damaged entry is skipped; it cannot be used to connect.
      }
    }
    return out
  }

  /** The enrollment that can reach `nodeId`: its roster holds a current delegation for that node. */
  async forComputer(accountId: string, nodeId: string, now: number): Promise<LoadedEnrollment | undefined> {
    const candidates = (await this.loaded(accountId)).filter((entry) => {
      if (entry.stored.enrollment.node === nodeId) return false
      try {
        currentNode(entry.roster, nodeId, now)
        currentNode(entry.roster, entry.stored.enrollment.node, now)
        return true
      } catch {
        return false
      }
    })
    return candidates.sort((a, b) => rosterPosition(b.roster, a.roster))[0]
  }

  async add(entry: StoredEnrollment): Promise<void> {
    await this.update((entries) => [...entries.filter((row) => row.enrollment.node !== entry.enrollment.node), entry])
  }

  async setGrant(node: string, grant: RegistrationGrant | undefined): Promise<void> {
    await this.update((entries) =>
      entries.map((row) => {
        if (row.enrollment.node !== node) return row
        const { grant: _old, ...rest } = row
        return grant ? { ...rest, grant } : rest
      }),
    )
  }

  /** Keeps a newer roster for every enrollment of the same user. */
  async setRoster(user: string, signed: Signed): Promise<void> {
    await this.update((entries) =>
      entries.map((row) => {
        if (row.enrollment.user !== user) return row
        try {
          const incoming = verifyRoster(signed, row.enrollment.rootKey)
          const held = verifyRoster(row.enrollment.roster, row.enrollment.rootKey)
          if (rosterPosition(incoming, held) <= 0) return row
        } catch {
          return row
        }
        return { ...row, enrollment: { ...row.enrollment, roster: signed } }
      }),
    )
  }

  /** Forgets every connector token, for example on sign-out. Enrollments stay. */
  async clearGrants(): Promise<void> {
    await this.update((entries) => entries.map(({ grant: _grant, ...rest }) => rest))
  }

  private update(change: (entries: StoredEnrollment[]) => StoredEnrollment[]): Promise<void> {
    const next = this.writing.then(async () => {
      this.entries = change(await this.list())
      await writeJson(this.storage, STORAGE_KEY, this.entries)
    })
    this.writing = next.catch(() => undefined)
    return next
  }
}
