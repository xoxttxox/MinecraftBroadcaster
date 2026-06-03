import { randomBytes } from 'crypto'
import {
  CREATE_HANDLE,
  CREATE_SESSION,
  SOCIAL_SUMMARY,
  USER_PRESENCE
} from '../core/constants'
import type { Logger } from '../core/logger'
import type { BedrockAuthService } from '../auth/bedrockAuth'
import { xblAuthorization } from '../auth/bedrockAuth'
import type { CoreConfigYaml } from '../config/config'
import { NetherNetSignaling } from '../network/jsonRpcSignaling'
import { RtaSession } from '../network/rtaSession'
import { notifyRtaSocialEvent } from '../services/notifications'
import type { ExpandedSessionInfo } from './expandedSessionInfo'
import type { PlayerHistoryStore } from '../storage/playerHistory'
import { buildCreateHandleRequest, buildCreateSessionRequest } from './payload'

type SessionMemberRow = {
  /** Wie Java {@code SessionMember.gamertag} — oft gesetzt, wenn Microsoft den Joiner liefert. */
  gamertag?: string
  constants?: { system?: { xuid?: string | number } }
}

type PutSessionOptions = {
  /** Wird beim initialen Aufbau/Full-Rotate genutzt, damit putSession nicht wieder checkConnection() rekursiv startet. */
  skipConnectionCheck?: boolean
}

function normalizeXuid(raw: string | number | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const s = String(raw).trim()
  return s.length > 0 ? s : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class XboxSessionController {
  rta: RtaSession | null = null
  readonly netherNet: NetherNetSignaling
  private nonces: Record<string, string> = {}
  lastHandleResponse = ''
  initialized = false

  /** Java rotiert bei ≥28/30 Mitgliedern — verhindert „volle“ Session / kaputten Join. */
  private sessionCrowdRestartScheduled = false
  /** Remote-XUIDs, die beim letzten Session-Directory-GET bereits als Member aktiv waren. */
  private readonly seenSessionMembers = new Set<string>()

  /** Verhindert parallele Rotationsläufe durch RTA-close, Interval und Session-GET/PUT gleichzeitig. */
  private recreatePromise: Promise<void> | null = null
  /** Soft-Reconnect bleibt in derselben Xbox-Session und erneuert nur die RTA-ConnectionId. */
  private rtaReconnectPromise: Promise<boolean> | null = null
  private rtaReconnectFailCount = 0
  private lastRtaConnectionLostAt = 0
  private sessionGetFailCount = 0
  private sessionPutFailCount = 0
  private lastFullSessionCreateAt = 0
  private lastSuccessfulSessionGetAt = 0
  private lastSuccessfulSessionPutAt = 0
  private lastPresenceUpdateAt = 0

  constructor(
    private readonly auth: BedrockAuthService,
    private readonly log: Logger,
    public session: ExpandedSessionInfo,
    private readonly onNonceRefresh: () => Promise<void>,
    private readonly onFriendRta: () => void,
    private readonly notifications: CoreConfigYaml['notifications'] | undefined,
    private readonly history?: PlayerHistoryStore,
    private readonly onSessionRecreated?: (reason: string) => void | Promise<void>,
    /** Millisekunden. 0 = deaktiviert. Schützt gegen Minecraft/Xbox-Client-Cache, der nach langer Laufzeit stale werden kann. */
    private readonly fullRefreshIntervalMs = 0,
    /** Anzahl Soft-Reconnect-Versuche für RTA, bevor eine harte Session-Rotation passiert. */
    private readonly rtaReconnectAttempts = 3,
    /** Pause zwischen Soft-Reconnect-Versuchen. */
    private readonly rtaReconnectDelayMs = 3_000
  ) {
    this.netherNet = new NetherNetSignaling(this.log)
  }

  private async tokenHeader(): Promise<string> {
    const x = await this.auth.getXboxToken()
    return xblAuthorization(x)
  }

  private createRtaSession(): RtaSession {
    return new RtaSession(
      () => this.tokenHeader(),
      this.session.xuid,
      this.log,
      {
        onFriendRequestCountChanged: () => this.onFriendRta(),
        onSessionNetworkChange: () => {
          void this.onNonceRefresh()
        },
        onConnectionLost: (reason) => {
          if (!this.initialized) return
          void this.handleRtaConnectionLost(reason)
        },
        onSocialGraphEvent: (ev) => {
          void notifyRtaSocialEvent(this.notifications, this.log, ev, () => this.tokenHeader())
        }
      }
    )
  }

  private async handleRtaConnectionLost(reason: string): Promise<void> {
    if (!this.initialized || this.recreatePromise) return

    this.lastRtaConnectionLostAt = Date.now()

    const ok = await this.ensureRtaConnection(`event:${reason}`)
    if (!ok && this.initialized) {
      await this.forceRecreateSession(`rta_reconnect_failed:${reason}`)
    }
  }

  async createFullSession(): Promise<void> {
    this.initialized = false

    const x = await this.auth.getXboxToken()
    this.session.xuid = x.userXUID

    this.rta = this.createRtaSession()

    await this.rta.connect()
    const connectionId = await this.rta.waitForConnectionId()
    this.session.connectionId = connectionId

    /** Franchise signaling auth — Java {@code NetherNetXboxRpcSignaling(netherNetId, getMCTokenHeader())}. */
    const { mcToken } = await this.auth.getMcTokenAndPmid()
    await this.netherNet.connect(this.session.netherNetId, mcToken, () => ({
      versionName: this.session.getVersion(),
      protocolVersion: this.session.getProtocol(),
      host: this.session.getIp(),
      port: this.session.getPort()
    }))

    /** Java sets pmid from Minecraft session JWT in {@code setupNetherNet} immediately before session PUT. */
    await this.syncPmsgWithMinecraftSession()
    if (!this.session.pmsgId?.trim()) {
      throw new Error(
        'Minecraft services token enthält keine pmid (PmsgId) — Freundes-Join bricht oft mit „Door“ ab. Cache löschen, neu anmelden, anderes auth.deviceProfile testen, bedrockVersion prüfen.'
      )
    }

    /** Beim initialen Aufbau nicht wieder checkConnection() aus putSession heraus starten. */
    await this.putSession({ skipConnectionCheck: true })
    await this.createActivityHandle()

    this.initialized = true
    this.lastFullSessionCreateAt = Date.now()
    this.sessionGetFailCount = 0
    this.sessionPutFailCount = 0
    this.rtaReconnectFailCount = 0

    /** Wichtig nach Full-Rotate: Presence sofort frisch setzen, nicht erst beim nächsten 5-Minuten-Heartbeat. */
    await this.updatePresenceOnce()
  }

  private async createActivityHandle(): Promise<void> {
    const auth = await this.tokenHeader()
    const handleBody = buildCreateHandleRequest(this.session.sessionId)
    const createHandleRes = await fetch(CREATE_HANDLE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'x-xbl-contract-version': '107'
      },
      body: JSON.stringify(handleBody)
    })
    const handleText = await createHandleRes.text()
    this.lastHandleResponse = handleText
    if (createHandleRes.status !== 200 && createHandleRes.status !== 201) {
      throw new Error(`create handle failed ${createHandleRes.status}: ${handleText}`)
    }
    try {
      const parsed = JSON.parse(handleText) as { id?: string }
      if (parsed.id) this.session.handleId = parsed.id
    } catch {
      /* ignore */
    }
  }

  async putSession(options: PutSessionOptions = {}): Promise<void> {
    if (!options.skipConnectionCheck) {
      const ok = await this.checkConnection()
      if (!ok) return
    }

    this.assertSessionMatchesNetherNetStack()
    this.log.debug(
      `[SessionCheckpoint] sessionId=${this.session.sessionId} netherNetId=${this.session.netherNetId.toString()} subscriptionId=${this.session.subscriptionId} connectionId=${this.session.connectionId || '(pending)'}`
    )
    const auth = await this.tokenHeader()
    const url = CREATE_SESSION(this.session.sessionId)
    const body = buildCreateSessionRequest(this.session, this.nonces)
    const bodyJson = JSON.stringify(body)
    this.assertJoinNetIdConsistency(body)
    this.log.debug(`[SessionPUT] ${url}`)
    this.log.debug(
      `[SessionPUT] body (truncated): ${bodyJson.length > 500 ? `${bodyJson.slice(0, 500)}…` : bodyJson}`
    )
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
        'x-xbl-contract-version': '107'
      },
      body: bodyJson
    })
    const text = await res.text()
    if (res.status !== 200 && res.status !== 201) {
      this.sessionPutFailCount += 1
      const msg = `session PUT failed ${res.status}: ${text}`
      this.log.warn(`${msg} (failCount=${this.sessionPutFailCount})`)

      if (this.sessionPutFailCount >= 3 || res.status === 404 || res.status === 409) {
        void this.forceRecreateSession(`session_put_failed:${res.status}`)
      }

      throw new Error(msg)
    }

    this.sessionPutFailCount = 0
    this.lastSuccessfulSessionPutAt = Date.now()

    try {
      const parsed = JSON.parse(text) as { members?: Record<string, SessionMemberRow> }
      const n = parsed.members ? Object.keys(parsed.members).length : 0
      if (n >= 28 && !this.sessionCrowdRestartScheduled) {
        this.sessionCrowdRestartScheduled = true
        this.log.warn(`Session has ${n}/30 members — rotating session (Java parity; fresher join metadata)`)
        setImmediate(() => {
          void this.recreateSessionDueToCrowding()
        })
      }
    } catch {
      /* ignore */
    }
  }

  /** Nach vielen Join-Versuchen bleiben „Geister“-Mitglieder → neue Session + NetherNet-ID. */
  private async recreateSessionDueToCrowding(): Promise<void> {
    try {
      await this.forceRecreateSession('member_crowding')
      this.log.info('Session recreated after member crowding — friends should use refreshed „Welten“ entry')
    } catch (e) {
      this.log.error('Crowded session recreation failed — restart the bot if join stays broken', e)
    } finally {
      this.sessionCrowdRestartScheduled = false
    }
  }

  async updateNonces(): Promise<void> {
    if (this.recreatePromise) return

    const auth = await this.tokenHeader()
    const url = CREATE_SESSION(this.session.sessionId)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: auth, 'x-xbl-contract-version': '107' }
      })
    } catch (e) {
      const hint = e instanceof Error ? e.message : String(e)
      this.sessionGetFailCount += 1
      this.log.warn(
        `updateNonces: session GET network error (${hint}) — join metadata may be stale until next tick (failCount=${this.sessionGetFailCount})`
      )
      if (this.sessionGetFailCount >= 3) {
        void this.forceRecreateSession('session_get_network_failed')
      }
      return
    }
    const text = await res.text()
    if (!res.ok) {
      this.sessionGetFailCount += 1
      this.log.warn(`updateNonces: session GET HTTP ${res.status} — ${text.slice(0, 200)} (failCount=${this.sessionGetFailCount})`)
      if (this.sessionGetFailCount >= 3 || res.status === 404 || res.status === 409) {
        void this.forceRecreateSession(`session_get_failed:${res.status}`)
      }
      return
    }

    this.sessionGetFailCount = 0
    this.lastSuccessfulSessionGetAt = Date.now()

    let parsed: { members?: Record<string, SessionMemberRow> }
    try {
      parsed = JSON.parse(text) as { members?: Record<string, SessionMemberRow> }
    } catch {
      this.log.warn('updateNonces: invalid JSON from session GET')
      return
    }
    this.log.debug(`[SessionGET Members RAW] ${JSON.stringify(parsed.members ?? null, null, 2)}`)
    if (!parsed.members) {
      this.log.warn('updateNonces: session members null — skipping nonce sync')
      return
    }
    const active = new Set<string>()
    const activeTags = new Map<string, string>()

    for (const m of Object.values(parsed.members)) {
      const x = normalizeXuid(m.constants?.system?.xuid)
      if (!x) continue

      active.add(x)
      activeTags.set(x, m.gamertag || x)
    }

    const hostXuid = normalizeXuid(this.session.xuid)
    if (hostXuid) {
      active.delete(hostXuid)
      activeTags.delete(hostXuid)
    }

    this.recordSessionMemberJoins(activeTags)
    let changed = false
    const joinBusy = this.netherNet.isJoinHandshakeActive()
    for (const k of Object.keys(this.nonces)) {
      if (!active.has(k)) {
        if (joinBusy) {
          this.log.debug(`[NONCES] keep nonce during active join xuid=${k} ttl=30s (WebRTC handshake)`)
          continue
        }
        delete this.nonces[k]
        changed = true
        this.log.debug(`[NONCES] removed nonce xuid=${k} reason=not in session GET members`)
      }
    }
    for (const xuid of active) {
      if (!this.nonces[xuid]) {
        this.nonces[xuid] = randomHex(16)
        changed = true
      }
    }
    if (changed) {
      this.log.debug(`Nonces updated for ${Object.keys(this.nonces).length} remote member(s) — next putSession will publish`)
    }
  }

  /**
   * Speichert Join-History genau dann, wenn ein Remote-XUID neu in der Xbox Session Directory auftaucht.
   * Dadurch zählt join_count nicht bei jedem Update hoch, sondern nur beim Wechsel: nicht aktiv -> aktiv.
   */
  private recordSessionMemberJoins(activeTags: Map<string, string>): void {
    const now = new Date().toISOString()

    for (const [xuid, gamertag] of activeTags) {
      if (this.seenSessionMembers.has(xuid)) continue

      this.seenSessionMembers.add(xuid)
      this.history?.touchPlayerJoin(xuid, gamertag || xuid, now)
      this.log.info(`Session member joined: ${gamertag || xuid} (${xuid})`)
    }

    for (const xuid of [...this.seenSessionMembers]) {
      if (!activeTags.has(xuid)) this.seenSessionMembers.delete(xuid)
    }
  }

  /**
   * RTA must stay up for Xbox session directory / friend notifications.
   * NetherNet franchise signaling is often closed by the server when idle — that is normal and must not rotate the session.
   */
  async checkConnection(): Promise<boolean> {
    if (this.recreatePromise) {
      await this.recreatePromise
      return this.initialized
    }

    const rtaOk = this.rta?.isOpen() ?? false
    if (!rtaOk) {
      const ok = await this.ensureRtaConnection('healthcheck')
      if (!ok && this.initialized) {
        await this.forceRecreateSession('rta_reconnect_failed:healthcheck')
      }
      return this.initialized
    }

    await this.ensureNetherNetSignaling()
    return this.initialized
  }

  /**
   * Soft-Reconnect: gleiche Xbox-Session behalten, nur RTA neu verbinden und neue ConnectionId publizieren.
   * Erst wenn das mehrfach nicht klappt, wird eine Full-Rotation ausgelöst.
   */
  private async ensureRtaConnection(source: string): Promise<boolean> {
    if (this.recreatePromise) {
      await this.recreatePromise
      return this.initialized
    }

    if (this.rta?.isOpen()) return true

    if (this.rtaReconnectPromise) return this.rtaReconnectPromise

    this.rtaReconnectPromise = (async () => {
      if (!this.rta) {
        this.log.warn(`RTA reconnect impossible — no RTA instance (${source})`)
        return false
      }

      const attempts = Math.max(1, Math.floor(this.rtaReconnectAttempts))
      const waitMs = Math.max(0, Math.floor(this.rtaReconnectDelayMs))

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!this.initialized || this.recreatePromise) return false

        try {
          this.log.warn(`RTA WebSocket lost — soft reconnect attempt ${attempt}/${attempts} (${source})`)

          await this.rta.connect()
          const connectionId = await this.rta.waitForConnectionId()
          this.session.connectionId = connectionId

          this.rtaReconnectFailCount = 0
          this.log.info(`RTA soft reconnect completed connectionId=${connectionId}`)

          /** Neue RTA-ConnectionId direkt in die bestehende Session schreiben. */
          await this.putSession({ skipConnectionCheck: true })
          await this.updatePresenceOnce()

          return true
        } catch (e) {
          this.rtaReconnectFailCount += 1
          const msg = e instanceof Error ? e.message : String(e)
          this.log.warn(
            `RTA soft reconnect failed attempt ${attempt}/${attempts}: ${msg} (totalFailCount=${this.rtaReconnectFailCount})`
          )

          if (attempt < attempts && waitMs > 0) {
            await delay(waitMs)
          }
        }
      }

      this.log.warn(`RTA soft reconnect failed after ${attempts} attempt(s) — full session rotation required`)
      return false
    })()

    try {
      return await this.rtaReconnectPromise
    } finally {
      this.rtaReconnectPromise = null
    }
  }

  /**
   * Proaktiver Full-Refresh gegen stale Minecraft/Xbox-Client-Caches.
   * Existing Spieler auf dem echten Bedrock/Geyser-Server bleiben verbunden; nur die advertised Xbox-Session wird frisch erstellt.
   */
  async maybeProactiveFullRefresh(): Promise<boolean> {
    if (!this.initialized) return false
    if (!this.fullRefreshIntervalMs || this.fullRefreshIntervalMs <= 0) return false
    if (!this.lastFullSessionCreateAt) return false

    const ageMs = Date.now() - this.lastFullSessionCreateAt
    if (ageMs < this.fullRefreshIntervalMs) return false

    await this.forceRecreateSession(`proactive_full_refresh:${Math.round(ageMs / 1000)}s`)
    return true
  }

  /**
   * Harte Rotation: neue Xbox-Session-ID, neue NetherNet-ID, neuer RTA-ConnectionId, neuer Activity-Handle und sofortige Presence-Aktualisierung.
   */
  async forceRecreateSession(reason: string): Promise<void> {
    if (this.recreatePromise) return this.recreatePromise

    this.recreatePromise = (async () => {
      const oldSessionId = this.session.sessionId
      const oldNetherNetId = this.session.netherNetId.toString()
      this.log.warn(`Full session rotation started: reason=${reason} oldSession=${oldSessionId} oldNetherNetId=${oldNetherNetId}`)

      await this.shutdown()
      this.session.rotateIdentity()
      this.nonces = {}
      this.seenSessionMembers.clear()

      await this.createFullSession()

      this.log.info(
        `Full session rotation completed: reason=${reason} newSession=${this.session.sessionId} newNetherNetId=${this.session.netherNetId.toString()} handle=${this.session.handleId ?? 'n/a'}`
      )
      await this.onSessionRecreated?.(reason)
    })()

    try {
      await this.recreatePromise
    } finally {
      this.recreatePromise = null
    }
  }

  /** Re-open franchise signaling if it dropped (idle timeout); same NetherNet id, fresh MCToken — no session rotation. */
  private async ensureNetherNetSignaling(): Promise<void> {
    if (!this.initialized) return
    if (this.netherNet.isOpen()) return
    this.log.info('NetherNet signaling reconnecting (idle close is expected)')
    try {
      const { mcToken } = await this.auth.getMcTokenAndPmid()
      await this.netherNet.connect(this.session.netherNetId, mcToken, () => ({
        versionName: this.session.getVersion(),
        protocolVersion: this.session.getProtocol(),
        host: this.session.getIp(),
        port: this.session.getPort()
      }))
      await this.syncPmsgWithMinecraftSession()
    } catch (e) {
      this.log.error('NetherNet signaling reconnect failed', e)
    }
  }

  /** Mirrors Java {@code sessionInfo.setPmsgId(...reqString("pmid"))} after NetherNet is up. */
  private async syncPmsgWithMinecraftSession(): Promise<void> {
    try {
      const { pmid } = await this.auth.getMcTokenAndPmid()
      if (pmid) this.session.pmsgId = pmid
      else this.log.warn('pmid not present in MC token JWT — friend join metadata may be incomplete')
    } catch (e) {
      this.log.error('Failed to sync pmid from Minecraft session token', e)
    }
  }

  /**
   * Harte Kette: {@code ExpandedSessionInfo.netherNetId} = {@code nethernet.Server.networkId}
   * = JsonRPC-WS-Binding ({@link NetherNetSignaling.lastFranchiseSignalingNetherNetId}). Keinesfalls zur Laufzeit auseinanderlaufen.
   */
  private assertSessionMatchesNetherNetStack(): void {
    const srv = this.netherNet.hostNetherNetServerNetworkId
    if (srv !== null && srv !== this.session.netherNetId) {
      const a = srv.toString()
      const b = this.session.netherNetId.toString()
      this.log.error(`[JoinNetId] MISMATCH connectedJsonRpc=${a} sessionPut=${b} (nethernet Server.networkId vs ExpandedSessionInfo)`)
      throw new Error('[JoinNetId] abort: Server.networkId ≠ session.netherNetId')
    }
    const wsBound = this.netherNet.lastFranchiseSignalingNetherNetId
    if (wsBound !== null && wsBound !== this.session.netherNetId) {
      const a = wsBound.toString()
      const b = this.session.netherNetId.toString()
      this.log.error(`[JoinNetId] MISMATCH connectedJsonRpc=${a} sessionPut=${b} (JsonRPC WS host binding vs session)`)
      throw new Error('[JoinNetId] abort: JsonRPC host NetherNetId ≠ session.netherNetId')
    }
  }

  /**
   * Xbox-Session und Host müssen dieselbe NetherNet-ID nutzen wie beim JsonRPC-Signaling
   * ({@code …/messaging/connect}, siehe MCXboxBroadcast Build 140+ / Kastle {@code NetherNetXboxRpcSignaling}).
   * Die ID steht nicht mehr in der WebSocket-URL — Vergleich nur session vs. {@link NetherNetSignaling.lastFranchiseSignalingNetherNetId}.
   */
  private assertJoinNetIdConsistency(body: object): void {
    const expectedBn = this.session.netherNetId
    const expectedNum = this.session.netherNetIdJsonNumber()
    const rows =
      (
        body as {
          properties?: {
            custom?: {
              SupportedConnections?: Array<{ NetherNetId?: number; WebRTCNetworkId?: number }>
            }
          }
        }
      ).properties?.custom?.SupportedConnections ?? []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (r.NetherNetId !== undefined && r.NetherNetId !== expectedNum) {
        throw new Error(
          `[JoinNetId] PUT SupportedConnections[${i}].NetherNetId=${r.NetherNetId} ≠ session.netherNetId ${expectedNum}`
        )
      }
      if (r.WebRTCNetworkId !== undefined && r.WebRTCNetworkId !== expectedNum) {
        throw new Error(
          `[JoinNetId] PUT SupportedConnections[${i}].WebRTCNetworkId=${r.WebRTCNetworkId} ≠ session.netherNetId ${expectedNum}`
        )
      }
    }
    const sig = this.netherNet.lastFranchiseSignalingNetherNetId
    const expStr = expectedBn.toString()
    if (sig === null) {
      this.log.warn(
        `[JoinNetId] PUT NetherNetId=${expStr} — JsonRPC-Signaling noch nicht bereit (keine gespeicherte Host-NetherNet-ID). Erwartet vor PUT ein Log: „NetherNet signaling (JsonRPC): …/messaging/connect netherNetId=${expStr}".`
      )
      return
    }
    if (sig !== expectedBn) {
      this.log.error(`[JoinNetId] MISMATCH connectedJsonRpc=${sig.toString()} sessionPut=${expStr}`)
      throw new Error('[JoinNetId] abort: session PUT vs JsonRPC signaling host NetherNetId')
    }
    this.log.debug(
      `[JoinNetId] OK: Session-PUT und JsonRPC-Host nutzen dieselbe NetherNet-ID ${expStr} (Put-Body und WS-Open konsistent).`
    )
  }

  async shutdown(): Promise<void> {
    this.initialized = false
    this.seenSessionMembers.clear()
    this.rta?.close()
    this.rta = null
    await this.netherNet.close()
  }

  private async updatePresenceOnce(): Promise<number> {
    const auth = await this.tokenHeader()
    const url = USER_PRESENCE(this.session.xuid)
    let heartbeatSec = 300
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: auth,
          'x-xbl-contract-version': '3'
        },
        body: JSON.stringify({ state: 'active' })
      })
      if (!res.ok) this.log.error(`Presence update failed: HTTP ${res.status}`)
      const hb = res.headers.get('X-Heartbeat-After')
      if (hb) {
        const n = parseInt(hb, 10)
        if (Number.isFinite(n)) heartbeatSec = n
      }
      this.lastPresenceUpdateAt = Date.now()
    } catch (e) {
      this.log.error('Presence update error', e)
    }
    return heartbeatSec
  }

  async schedulePresence(chain: () => void): Promise<void> {
    const heartbeatSec = await this.updatePresenceOnce()
    this.log.debug(`Next presence in ${heartbeatSec}s`)
    setTimeout(chain, heartbeatSec * 1000)
  }

  async socialSummary(): Promise<{ targetFollowingCount: number }> {
    try {
      const auth = await this.tokenHeader()
      const res = await fetch(SOCIAL_SUMMARY, { headers: { Authorization: auth } })
      const j = (await res.json()) as { targetFollowingCount?: number }
      return { targetFollowingCount: j.targetFollowingCount ?? -1 }
    } catch {
      return { targetFollowingCount: -1 }
    }
  }
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}
