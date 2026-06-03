import {
  CREATE_HANDLE,
  FOLLOWERS,
  MAX_FRIENDS,
  PEOPLE,
  SERVICE_CONFIG_ID,
  SOCIAL,
  TEMPLATE_NAME,
  TITLE_ID
} from '../core/constants'
import type { CoreConfigYaml } from '../config/config'
import type { Logger } from '../core/logger'
import {
  notifyFriendAdded,
  notifyFriendExpiryRemoval,
  notifyFriendRemoved,
  notifyFriendRemovedRemote,
  notifyFriendRequestAccepted
} from '../services/notifications'
import type { PlayerHistoryStore } from '../storage/playerHistory'

export type Person = {
  xuid: string
  displayName: string
  isFollowingCaller: boolean
  isFollowedByCaller: boolean
}

function mergePeople(lists: Person[][]): Person[] {
  const map = new Map<string, Person>()
  for (const list of lists) {
    for (const p of list) {
      const cur = map.get(p.xuid)
      if (!cur) map.set(p.xuid, { ...p })
      else {
        map.set(p.xuid, {
          xuid: p.xuid,
          displayName: p.displayName || cur.displayName,
          isFollowingCaller: cur.isFollowingCaller || p.isFollowingCaller,
          isFollowedByCaller: cur.isFollowedByCaller || p.isFollowedByCaller
        })
      }
    }
  }
  return [...map.values()]
}

function parseFollowerResponse(body: string): Person[] {
  if (!body) return []
  try {
    const j = JSON.parse(body) as { people?: any[] }
    if (!j.people) return []
    return j.people.map((row) => ({
      xuid: String(row.xuid ?? row.id ?? ''),
      displayName: String(row.displayName ?? row.gamertag ?? row.modernGamertag ?? ''),
      isFollowingCaller: Boolean(row.isFollowingCaller),
      isFollowedByCaller: Boolean(row.isFollowedByCaller)
    }))
  } catch {
    return []
  }
}

function isGuestXuid(xuid: string): boolean {
  try {
    const n = BigInt(xuid)
    return (n >> 52n) === 1n
  } catch {
    return false
  }
}

/** Antwort von {@code .../people/friends/v2?method=add} — Microsoft variiert die Keys. */
function extractBulkFriendAcceptXuids(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const o = body as Record<string, unknown>
  const raw = o.updatedPeople ?? o.UpdatedPeople
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean)
  return []
}

export class FriendSync {
  private lastCache: Person[] = []
  private toAdd = new Map<string, string>()
  private toRemove = new Map<string, string>()
  private processing = false
  private initialInvite = true
  private friendCfg: CoreConfigYaml['friendSync'] | undefined
  private notifications: CoreConfigYaml['notifications'] | undefined
  /** Vorherige Merge-Liste: XUID → Anzeigename für Discord ({@link notifyFriendRemovedRemote} = `friendRemovedMessage`). */
  private mergedSocialTags = new Map<string, string>()
  /** Resolved after session is live — used for session invites */
  public getSessionId: () => string = () => ''

  constructor(
    private readonly getAuth: () => Promise<string>,
    private readonly log: Logger,
    private readonly history: PlayerHistoryStore,
    private readonly schedule: (fn: () => void, delayMs: number, periodMs: number) => void
  ) { }

  async getMergedPeople(): Promise<Person[]> {
    const auth = await this.getAuth()
    const headers = {
      Authorization: auth,
      'x-xbl-contract-version': '5',
      'accept-language': 'en-GB'
    }
    const [r1, r2] = await Promise.all([fetch(FOLLOWERS, { headers }), fetch(SOCIAL, { headers })])
    const people = mergePeople([parseFollowerResponse(await r1.text()), parseFollowerResponse(await r2.text())])
    this.lastCache = people
    return people
  }

  /** Ob „Freundschaftsanfragen annehmen“ (bulk API) aktiv ist — sonst kommt {@link notifyFriendRequestAccepted} nie. */
  private allowAcceptIncomingFriendRequests(cfg: NonNullable<CoreConfigYaml['friendSync']>): boolean {
    if (cfg.autoAcceptIncomingFriendRequests !== undefined) return cfg.autoAcceptIncomingFriendRequests
    return cfg.autoFollow !== false
  }

  async acceptPendingFriendRequests(): Promise<void> {
    const cfg = this.friendCfg
    if (!cfg || !this.allowAcceptIncomingFriendRequests(cfg)) return
    const auth = await this.getAuth()
    const headers = {
      Authorization: auth,
      'x-xbl-contract-version': '7',
      'accept-language': 'en-GB'
    }
    try {
      const fr = await fetch('https://peoplehub.xboxlive.com/users/me/people/friendrequests(received)', {
        headers
      })
      if (!fr.ok) {
        this.log.debug(`Friend requests GET HTTP ${fr.status}`)
        return
      }
      const body = await fr.json()
      const people = (body as { people?: { xuid: string; gamertag?: string }[] }).people
      if (!people?.length) return
      const xuids = people.map((p) => p.xuid)
      const acc = await fetch('https://social.xboxlive.com/bulk/users/me/people/friends/v2?method=add', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ xuids })
      })
      const accText = await acc.text()
      let accBody: unknown = {}
      try {
        accBody = accText ? JSON.parse(accText) : {}
      } catch {
        accBody = {}
      }
      let updated = extractBulkFriendAcceptXuids(accBody)
      if (!updated.length && acc.ok && xuids.length > 0) {
        const alt = (accBody as { results?: { xuid?: string }[] }).results
        if (Array.isArray(alt)) {
          updated = alt.map((r) => String(r?.xuid ?? '')).filter(Boolean)
        }
      }
      if (!updated.length && acc.ok && xuids.length === 1) {
        updated = [...xuids]
      }
      if (!updated.length) {
        this.log.warn(
          `Friend accept: bulk add OK=${acc.ok} HTTP ${acc.status} but no updated XUIDs; body=${accText.slice(0, 400)}`
        )
        return
      }
      for (const xuid of updated) {
        const g = people.find((p) => p.xuid === xuid)?.gamertag ?? xuid
        this.log.info(`Accepted friend request from ${g} (${xuid})`)
        this.history.touchFriendRequestAccepted(xuid, g)
        await notifyFriendRequestAccepted(this.notifications, this.log, g, xuid)
        await this.sendSessionInvite(auth, xuid, g)
      }
    } catch (e) {
      this.log.error('Failed to accept pending friend requests', e)
    }
  }

  init(cfg: CoreConfigYaml['friendSync'], notifications?: CoreConfigYaml['notifications']): void {
    this.friendCfg = cfg
    this.notifications = notifications
    if (!cfg) return
    this.initialInvite = cfg.initialInvite !== false
    const interval = (cfg.updateInterval ?? 60) * 1000

    const pollMergedList =
      cfg.autoFollow ||
      cfg.autoUnfollow ||
      (notifications?.enabled === true && Boolean(notifications?.webhookUrl?.trim()))

    const pollAccept = this.allowAcceptIncomingFriendRequests(cfg)

    if (pollMergedList) {
      this.schedule(
        () =>
          void (async () => {
            await this.syncRound(cfg)
            await this.acceptPendingFriendRequests()
          })(),
        interval,
        interval
      )
    } else if (pollAccept) {
      this.schedule(() => void this.acceptPendingFriendRequests(), interval, interval)
    }

    if (cfg.expiry?.enabled) {
      const checkMs = (cfg.expiry.check ?? 1800) * 1000
      const days = cfg.expiry.days ?? 15
      this.schedule(() => void this.expiryRound(days), 10_000, checkMs)
    }

    void this.bootstrapHistory(cfg)
  }

  private async bootstrapHistory(cfg: NonNullable<CoreConfigYaml['friendSync']>): Promise<void> {
    if (!cfg.expiry?.enabled) return
    try {
      if (this.history.isFirstRun()) {
        this.log.info('Player history first run; seeding from friend list')
        const friends = await this.getMergedPeople()
        const now = new Date().toISOString()
        for (const f of friends) {
          this.history.touchSocialLastSeen(f.xuid, f.displayName || f.xuid, now)
        }
      } else {
        const friends = await this.getMergedPeople()
        const fx = new Set(friends.map((f) => f.xuid))
        for (const x of Object.keys(this.history.all())) {
          if (!fx.has(x)) this.history.clear(x)
        }
        const known = new Set(Object.keys(this.history.all()))
        const now = new Date().toISOString()
        for (const f of friends) {
          if (!known.has(f.xuid)) {
            this.history.touchSocialLastSeen(f.xuid, f.displayName || f.xuid, now)
          }
        }
      }
    } catch (e) {
      this.log.error('Friend history bootstrap failed', e)
    }
  }

  private async syncRound(cfg: NonNullable<CoreConfigYaml['friendSync']>): Promise<void> {
    try {
      const people = await this.getMergedPeople()
      const now = new Date().toISOString()

      const currentTags = new Map<string, string>()

      for (const person of people) {
        if (isGuestXuid(person.xuid)) continue

        const tag = person.displayName || person.xuid

        // Für Discord-Remove-Check merken
        currentTags.set(person.xuid, tag)

        // Player-History für Expiry aktualisieren
        this.history.touchSocialLastSeen(person.xuid, tag, now)
      }

      if (this.notifications?.enabled && this.notifications.webhookUrl?.trim()) {
        if (currentTags.size === 0 && this.mergedSocialTags.size > 8) {
          this.log.warn(
            'Friend sync: merged Xbox list is empty — skipping friend-removed webhooks (possible API error)'
          )
        } else if (this.mergedSocialTags.size > 0) {
          for (const [xuid, tag] of this.mergedSocialTags) {
            if (!currentTags.has(xuid)) {
              await notifyFriendRemovedRemote(this.notifications, this.log, tag, xuid)
            }
          }
        }
      }

      this.mergedSocialTags = currentTags

      for (const person of people) {
        if (isGuestXuid(person.xuid)) continue

        const tag = person.displayName || person.xuid

        if (cfg.autoFollow && person.isFollowingCaller && !person.isFollowedByCaller) {
          this.toAdd.set(person.xuid, tag)
        }

        if (cfg.autoUnfollow && !person.isFollowingCaller && person.isFollowedByCaller) {
          this.toRemove.set(person.xuid, tag)
        }
      }

      await this.flushMutations()
    } catch (e) {
      this.log.error('Friend sync failed', e)
    }
  }

  private async expiryRound(days: number): Promise<void> {
    const cutoff = Date.now() - days * 86400_000
    for (const [xuid, iso] of Object.entries(this.history.all())) {
      const t = Date.parse(iso)
      if (Number.isFinite(t) && t < cutoff) {
        this.log.info(`Removing inactive friend ${xuid}`)
        this.toRemove.set(xuid, 'inactive')
      }
    }
    await this.flushMutations()
  }

  private async flushMutations(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      const auth = await this.getAuth()
      for (const [xuid, tag] of [...this.toAdd]) {
        const res = await fetch(PEOPLE(xuid), { method: 'PUT', headers: { Authorization: auth } })
        if (res.status === 204) {
          this.toAdd.delete(xuid)
          this.log.info(`Added ${tag} (${xuid}) as a friend`)
          await notifyFriendAdded(this.notifications, this.log, tag, xuid)
          await this.sendSessionInvite(auth, xuid, tag)
        }
      }
      for (const [xuid, tag] of [...this.toRemove]) {
        const res = await fetch(PEOPLE(xuid), { method: 'DELETE', headers: { Authorization: auth } })
        if (res.status === 204 || res.status === 200) {
          this.toRemove.delete(xuid)
          this.log.info(`Removed ${tag} (${xuid})`)
          if (tag === 'inactive') {
            await notifyFriendExpiryRemoval(this.notifications, this.log, xuid)
          } else {
            await notifyFriendRemoved(this.notifications, this.log, tag, xuid)
          }
          this.history.clear(xuid)
        }
      }
    } finally {
      this.processing = false
    }
  }

  private async sendSessionInvite(auth: string, xuid: string, gamertag = ''): Promise<void> {
    if (!this.initialInvite) return
    const sessionId = this.getSessionId()
    if (!sessionId) return
    const body = {
      version: 1,
      type: 'invite',
      sessionRef: { scid: SERVICE_CONFIG_ID, templateName: TEMPLATE_NAME, name: sessionId },
      invitedXuid: xuid,
      inviteAttributes: { titleId: TITLE_ID }
    }
    try {
      const res = await fetch(CREATE_HANDLE, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          'x-xbl-contract-version': '107'
        },
        body: JSON.stringify(body)
      })
      const text = await res.text()
      this.log.debug(`Invite response ${res.status}: ${text.slice(0, 200)}`)
      if (res.ok) this.history.touchInviteSent(xuid, gamertag || xuid)
    } catch (e) {
      this.log.error(`Failed to send session invite to ${xuid}`, e)
    }
  }

  followerSummary(): { count: number; max: number } {
    return { count: this.lastCache.length, max: MAX_FRIENDS }
  }
}
