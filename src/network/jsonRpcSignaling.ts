import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import { Server, SignalStructure, SignalType } from 'nethernet'
import type { IceServer } from 'node-datachannel'
import {
  NETHERNET_JSONRPC_SIGNALING_WS,
  NETHERNET_SIGNALING_USER_AGENT
} from '../core/constants'
import type { Logger } from '../core/logger'
import { createNetherNetHost } from './webrtcPeer'
import type { NetherNetRelayTarget } from './webrtcPeer'

/**
 * Xbox Franchise **JsonRPC** Signaling (Build 139+/[Build 140](https://modrinth.com/mod/mcxboxbroadcast/version/140)):
 * {@link NETHERNET_JSONRPC_SIGNALING_WS} — nicht mehr `…/signaling/&lt;NetherNetId&gt;`.
 * WebRTC-Zeilentrigger kommen über `Signaling_ReceiveMessage_v1_0` → inner `Signaling_WebRtc_v1_0`.
 *
 * **Checkpoint-Reihenfolge bei einem Join:** `[JsonRPC] connected` → `[JsonRPC] TurnAuth ready` →
 * `[JsonRPC RX] Signaling_WebRtc_v1_0 message=CONNECTREQUEST` → `[WebRTC] offer received` → Kandidaten →
 * `[WebRTC] answer sent` → `[WebRTC] data channel open` → `[BedrockRedirect] rx …`. Fehlt eine Zeile,
 * siehe Kommentar an der jeweiligen Log-Stelle (warum sie ausbleiben kann).
 */

/** Parität zu {@code dev.kastle.netty.channel.nethernet.NetherNetConstants} (JsonRPC-Signaling). */
const RPC_TURN_AUTH = 'Signaling_TurnAuth_v1_0'
const RPC_SEND_MESSAGE = 'Signaling_SendClientMessage_v1_0'
const RPC_RECEIVE_MESSAGE = 'Signaling_ReceiveMessage_v1_0'
const RPC_PING = 'System_Ping_v1_0'
const RPC_PONG = 'System_Pong_v1_0'
const RPC_INNER_WEBRTC = 'Signaling_WebRtc_v1_0'
const RPC_INNER_DELIVERY = 'Signaling_DeliveryNotification_V1_0'

/** If franchise ICE JSON is empty, still offer Microsoft relay (same hosts as game / Education docs). */
const FALLBACK_ICE_URLS = [
  'stun:relay.communication.microsoft.com:3478',
  'turn:relay.communication.microsoft.com:3478',
  'turns:relay.communication.microsoft.com:443'
] as const

/** Franchise / Delivery-Umschlag — gleiche Felder wie vor JsonRPC-Umstellung. */
type FranchiseEnvelope = {
  Type?: number
  Message?: string
  From?: string | number
  To?: string | number
} & Record<string, unknown>

function franchiseRouteIdForJoiner(env: FranchiseEnvelope, hostIdStr: string): string | undefined {
  const hostNorm = hostIdStr.replace(/\s+/g, '')
  const tryVal = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined
    const s = String(v).trim()
    if (!s || s === hostNorm) return undefined
    return s
  }
  const named =
    tryVal(env.From) ??
    tryVal(env.SenderId) ??
    tryVal(env.SenderNetworkId) ??
    tryVal(env.PeerId) ??
    tryVal(env.PeerNetworkId) ??
    tryVal(env.SourceNetworkId) ??
    tryVal(env.RemoteNetworkId) ??
    tryVal(env.PartnerNetworkId) ??
    tryVal(env.ClientNetworkId)
  if (named) return named
  for (const [k, v] of Object.entries(env)) {
    if (k === 'Type' || k === 'Message') continue
    const s = tryVal(v)
    if (!s) continue
    if (!/^\d+$/.test(s)) continue
    try {
      if (BigInt(s) === BigInt(hostNorm)) continue
    } catch {
      continue
    }
    return s
  }
  return undefined
}

function jsonRouteValue(routeTo: string): string | number {
  try {
    const n = BigInt(routeTo)
    if (n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n)
  } catch {
    /* ignore */
  }
  return routeTo
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
}

function parseStunTurnUrl(url: string): { hostname: string; port: number; relayType?: IceServer['relayType'] } | null {
  const m = url.match(/^(stun|turn|turns):([^:]+)(?::(\d+))?$/)
  if (!m) return null
  const kind = m[1]
  const hostname = m[2]
  const explicit = m[3] ? parseInt(m[3], 10) : undefined
  let port = explicit ?? 3478
  let relayType: IceServer['relayType'] | undefined
  if (kind === 'turn') {
    relayType = 'TurnUdp'
  } else if (kind === 'turns') {
    relayType = 'TurnTls'
    if (explicit === undefined) port = 443
  }
  return { hostname, port, relayType }
}

function mergeIceServers(existing: (string | IceServer)[], add: (string | IceServer)[]): void {
  const seen = new Set<string>()
  for (const x of existing) {
    seen.add(typeof x === 'string' ? x : `${x.hostname}:${x.port}:${x.username ?? ''}`)
  }
  for (const x of add) {
    const k = typeof x === 'string' ? x : `${x.hostname}:${x.port}:${x.username ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    existing.push(x)
  }
}

/** TurnAuth-TURN-Parsing — gleiches Layout wie früheres Franchise Typ-2 / Java {@code parseTurnServers}. */
function iceServersFromFranchiseInner(inner: Record<string, unknown>): (string | IceServer)[] {
  const out: (string | IceServer)[] = []
  const topUser = String(inner.Username ?? '')
  const topPass = String(inner.Password ?? '')
  const rootUrls = inner.Urls ?? inner.urls
  if (Array.isArray(rootUrls)) {
    for (const url of rootUrls) {
      if (typeof url !== 'string') continue
      const parsed = parseStunTurnUrl(url)
      if (parsed) {
        out.push({
          hostname: parsed.hostname,
          port: parsed.port,
          username: topUser,
          password: topPass,
          ...(parsed.relayType ? { relayType: parsed.relayType } : {})
        })
      } else out.push(url)
    }
  }

  const list = inner.TurnAuthServers ?? inner.turnAuthServers
  if (!Array.isArray(list)) return out

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    const u = String(s.Username ?? s.username ?? topUser)
    const p = String(s.Password ?? s.password ?? topPass)
    const urlsRaw = s.Urls ?? s.urls
    if (!Array.isArray(urlsRaw)) continue
    for (const url of urlsRaw) {
      if (typeof url !== 'string') continue
      const parsed = parseStunTurnUrl(url)
      if (parsed) {
        out.push({
          hostname: parsed.hostname,
          port: parsed.port,
          username: u,
          password: p,
          ...(parsed.relayType ? { relayType: parsed.relayType } : {})
        })
      } else {
        out.push(url)
      }
    }
  }
  return out
}

const ICE_CONFIG_FALLBACK_MS = 10_000
/** Erster JsonRPC-Ping nach 30 s, danach alle 50 s — wie Java {@code NetherNetXboxRpcSignaling#onConnected}. */
const RPC_PING_INITIAL_MS = 30_000
const RPC_PING_PERIOD_MS = 50_000

type RpcPending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }

const INNER_RAW_MAX = 6000

export class NetherNetSignaling {
  private ws: WebSocket | null = null
  /** WS-native ping entfällt — JsonRPC {@code System_Ping_v1_0}. */
  private rpcPingInitialTimer: ReturnType<typeof setTimeout> | null = null
  private rpcPingInterval: ReturnType<typeof setInterval> | null = null
  private iceConfigWaitTimer: ReturnType<typeof setTimeout> | null = null
  private netherServer: Server | null = null
  private franchiseWsNetherNetId: bigint | null = null
  private iceCredentials: (string | IceServer)[] = []
  private gotIceConfig = false
  private pendingType1: FranchiseEnvelope[] = []
  private signalPeerByConnectionId = new Map<string, string>()
  private lastJoinerFranchiseFrom: string | undefined
  private pendingRpc = new Map<string, RpcPending>()
  /**
   * {@code nethernet} Server verwirft {@code handleCandidate}, wenn noch keine Connection existiert (Offer kam noch nicht).
   * Joiner können ICE vor/ab parallel zum CONNECTREQUEST schicken — puffern bis {@link flushPendingCandidatesForConnection}.
   */
  private pendingCandidatesByConn = new Map<string, SignalStructure[]>()
  /** Nach erfolgreichem {@code handleOffer} — bis dahin können Kandidaten nur gepuffert werden. */
  private joinOfferCompleted = false
  /** Wenn zuerst CANDIDATEADD ohne abgeschlossenes Offer: alle WebRTC-Zeilen roh loggen. */
  private dumpRawWebRtcUntilOffer = false
  /**
   * Inneres JsonRPC {@code params.netherNetId} pro {@code connectionId} — **nur Logs/Diagnose**.
   * {@code Signaling_SendClientMessage_v1_0.toPlayerId} ist **System.Guid** = {@code envelope.From}, nie diese ID.
   */
  private remoteInnerNetherNetIdByConn = new Map<string, string>()
  /** Letztes {@code params.netherNetId} aus dem aktuellen ReceiveMessage-Element (vor {@link handleFranchiseType1}). */
  private lastInnerNetherNetIdFromJsonRpc: string | undefined
  /** Solange Join-Handshake läuft: Nonces nicht anhand leerer Session-Members löschen ({@link XboxSessionController.updateNonces}). */
  private joinHandshakeUntil = 0

  constructor(private readonly log: Logger) {}

  /** True ~30s nach CONNECTREQUEST/Kandidaten — schützt Nonces während ICE/WebRTC. */
  isJoinHandshakeActive(): boolean {
    return Date.now() < this.joinHandshakeUntil
  }

  private bumpJoinHandshake(): void {
    this.joinHandshakeUntil = Date.now() + 30_000
  }

  private bufferOrHandleCandidate(ns: Server, signal: SignalStructure): void {
    const conn = ns.connections.get(signal.connectionId)
    const key = signal.connectionId.toString()
    if (conn) {
      this.log.debug(`[WebRTC] candidate add start connectionId=${key}`)
      void ns.handleCandidate(signal).then(
        () => this.log.debug(`[WebRTC] candidate add OK connectionId=${key}`),
        (e: unknown) =>
          this.log.warn(
            `[WebRTC] candidate add FAILED connectionId=${key} error=${e instanceof Error ? e.message : String(e)}`
          )
      )
      return
    }
    const list = this.pendingCandidatesByConn.get(key) ?? []
    list.push(signal)
    this.pendingCandidatesByConn.set(key, list)
    this.log.debug('[WebRTC] candidate buffered')
    this.log.debug(`[WebRTC] candidate buffered detail connectionId=${key} queueLen=${list.length}`)
  }

  private flushPendingCandidatesForConnection(ns: Server, connectionId: bigint): void {
    const key = connectionId.toString()
    const pending = this.pendingCandidatesByConn.get(key)
    if (!pending?.length) return
    this.pendingCandidatesByConn.delete(key)
    void (async () => {
      let i = 0
      for (const sig of pending) {
        i++
        this.log.debug(`[WebRTC] candidate add start connectionId=${key} (flush ${i}/${pending.length})`)
        try {
          await ns.handleCandidate(sig)
          this.log.debug(`[WebRTC] candidate add OK connectionId=${key} (flush ${i}/${pending.length})`)
        } catch (e) {
          const hint = e instanceof Error ? e.message : String(e)
          this.log.warn(`[WebRTC] candidate add FAILED connectionId=${key} (flush ${i}/${pending.length}) error=${hint}`)
        }
      }
      this.log.debug(`[WebRTC] flushed ${pending.length} buffered candidates`)
    })()
  }

  private logFranchiseEnvelopeHint(env: FranchiseEnvelope): void {
    const parts: string[] = []
    for (const [k, v] of Object.entries(env)) {
      if (k === 'Message') continue
      const s = v === null || v === undefined ? '' : String(v).trim()
      if (!s) continue
      parts.push(`${k}=${s.length > 24 ? `${s.slice(0, 24)}…` : s}`)
    }
    this.log.warn(`NetherNet Type-1 Hülle (ohne Message): ${parts.join(', ') || '(leer)'}`)
  }

  private handleFranchiseType1(
    env: FranchiseEnvelope,
    hostIdStr: string,
    sendSignal: (sig: SignalStructure) => void
  ): void {
    let signal: SignalStructure
    try {
      signal = SignalStructure.fromString(env.Message as string)
    } catch (e) {
      this.log.warn(`NetherNet bad signal line: ${(e as Error).message}`)
      return
    }

    const cid = signal.connectionId.toString()
    if (this.lastInnerNetherNetIdFromJsonRpc) {
      this.remoteInnerNetherNetIdByConn.set(cid, this.lastInnerNetherNetIdFromJsonRpc)
    }

    const joinerRoute = franchiseRouteIdForJoiner(env, hostIdStr)
    if (joinerRoute) {
      this.lastJoinerFranchiseFrom = joinerRoute
      this.signalPeerByConnectionId.set(signal.connectionId.toString(), joinerRoute)
    } else if (env.From !== undefined && env.From !== null && env.From !== '') {
      const fromStr = String(env.From)
      if (fromStr !== hostIdStr) {
        this.lastJoinerFranchiseFrom = fromStr
        this.signalPeerByConnectionId.set(signal.connectionId.toString(), fromStr)
      }
    }

    const nid = joinerRoute ?? this.signalPeerByConnectionId.get(signal.connectionId.toString())
    if (nid !== undefined) {
      try {
        ;(signal as { networkId?: bigint }).networkId = BigInt(nid)
      } catch {
        /* ignore */
      }
    }

    this.log.debug(
      `[WebRTC] route joinerRoute=${joinerRoute ?? '—'} connectionId=${signal.connectionId} hostId=${hostIdStr}`
    )

    const ns = this.netherServer
    if (!ns) return

    void (async () => {
      try {
        const iceForPeer =
          this.iceCredentials.length > 0 ? this.iceCredentials : [...FALLBACK_ICE_URLS]
        switch (signal.type) {
          case SignalType.ConnectRequest:
            this.bumpJoinHandshake()
            /** Ohne diese Zeile: kein CONNECTREQUEST vom Joiner — Freund hat nicht gewählt / falsche NetherNet-Zeile / Routing To fehlt. */
            this.log.info('[WebRTC] offer received')
            this.log.debug(
              `[JoinTest] CONNECTREQUEST handleOffer start connectionId=${signal.connectionId} joinerRoute=${joinerRoute ?? this.lastJoinerFranchiseFrom ?? '—'} ice=${iceForPeer.length}`
            )
            if (!joinerRoute && !this.lastJoinerFranchiseFrom) {
              this.log.warn(
                `NetherNet: Keine Joiner-ID — Antworten ohne To. Keys: ${Object.keys(env).join(', ')}`
              )
              this.logFranchiseEnvelopeHint(env)
            }
            if (this.iceCredentials.length === 0) {
              this.log.warn('NetherNet: using built-in Microsoft STUN/TURN fallback (no franchise ICE yet)')
            }
            try {
              await ns.handleOffer(signal, sendSignal, iceForPeer)
              this.joinOfferCompleted = true
              this.dumpRawWebRtcUntilOffer = false
              this.flushPendingCandidatesForConnection(ns, signal.connectionId)
              this.log.debug(`[JoinTest] CONNECTREQUEST handleOffer OK connectionId=${signal.connectionId}`)
            } catch (e) {
              const hint = e instanceof Error ? e.message : String(e)
              this.log.error(`[JoinTest] CONNECTREQUEST handleOffer FAILED connectionId=${signal.connectionId}: ${hint}`, e)
              throw e
            }
            break
          case SignalType.CandidateAdd:
            this.bumpJoinHandshake()
            if (!this.joinOfferCompleted) {
              this.dumpRawWebRtcUntilOffer = true
              this.log.warn(
                '[WebRTC] CANDIDATEADD before offer completed — will log raw params.message for subsequent WebRTC lines until CONNECTREQUEST succeeds'
              )
            }
            /** Ohne diese Zeile: kein ICE vom Joiner oder Signaling-To falsch. */
            this.log.debug('[WebRTC] candidate received')
            this.bufferOrHandleCandidate(ns, signal)
            break
          case SignalType.ConnectError:
            this.log.warn(`NetherNet CONNECTERROR (connection ${signal.connectionId}): ${signal.data}`)
            break
          default:
            break
        }
      } catch (e) {
        this.log.error('NetherNet WebRTC signaling handle failed', e)
      }
    })()
  }

  private flushPendingType1(hostIdStr: string, sendSignal: (sig: SignalStructure) => void): void {
    const q = this.pendingType1
    this.pendingType1 = []
    for (const env of q) {
      this.handleFranchiseType1(env, hostIdStr, sendSignal)
    }
  }

  private applyIceFromTurnAuth(result: Record<string, unknown>, hostIdStr: string, sendSignal: (s: SignalStructure) => void): void {
    const ice = iceServersFromFranchiseInner(result)
    mergeIceServers(this.iceCredentials, ice)
    if (this.iceCredentials.length === 0) {
      mergeIceServers(this.iceCredentials, [...FALLBACK_ICE_URLS])
      this.log.warn('NetherNet: TurnAuth ICE list empty — using Microsoft relay fallback')
    }
    this.gotIceConfig = true
    if (this.iceConfigWaitTimer) {
      clearTimeout(this.iceConfigWaitTimer)
      this.iceConfigWaitTimer = null
    }
    this.log.info(`[JsonRPC] TurnAuth ready (${this.iceCredentials.length} ICE server(s))`)
    this.log.debug(`NetherNet ICE detail: ${JSON.stringify(this.iceCredentials).slice(0, 800)}`)
    this.flushPendingType1(hostIdStr, sendSignal)
  }

  private sendJsonRpcFrame(method: string, params: Record<string, unknown>, id: string): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const rpc = {
      jsonrpc: '2.0',
      method,
      params,
      id
    }
    ws.send(JSON.stringify(rpc))
  }

  private sendJsonRpcResult(id: unknown, result: unknown): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const response: Record<string, unknown> = {
      jsonrpc: '2.0',
      id,
      result
    }
    ws.send(JSON.stringify(response))
  }

  private sendJsonRpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('NetherNet JsonRPC channel closed'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject })
      this.sendJsonRpcFrame(method, params, id)
    })
  }

  private rpcFailCleanup(): void {
    for (const [, p] of this.pendingRpc) {
      p.reject(new Error('NetherNet JsonRPC channel closed'))
    }
    this.pendingRpc.clear()
  }

  private handleJsonRpcResponse(json: Record<string, unknown>): void {
    const idRaw = json.id
    if (idRaw === undefined || idRaw === null) return
    const id = typeof idRaw === 'string' ? idRaw : String(idRaw)
    const pending = this.pendingRpc.get(id)
    if (!pending) return

    if (json.error !== undefined && json.error !== null) {
      const errObj = json.error as Record<string, unknown>
      let msg = 'JsonRPC error'
      if (typeof errObj.message === 'string') msg = errObj.message
      else msg = JSON.stringify(errObj)
      this.pendingRpc.delete(id)
      pending.reject(new Error(msg))
      return
    }

    const res = json.result
    this.pendingRpc.delete(id)
    if (res !== undefined && res !== null && typeof res === 'object' && !Array.isArray(res)) {
      pending.resolve(res as Record<string, unknown>)
    } else {
      pending.resolve({})
    }
  }

  /** Delivery-Bestätigung an Absender — gleiche Session wie JsonRPC {@code ReceiveMessage}. */
  private sendDeliveryAck(fromPlayerId: string, messageId: string): Promise<void> {
    const innerMsg = {
      jsonrpc: '2.0',
      method: RPC_INNER_DELIVERY,
      params: { messageId }
    }
    return this.sendJsonRpc(RPC_SEND_MESSAGE, this.createSendParams(fromPlayerId, JSON.stringify(innerMsg))).then(
      () => undefined
    )
  }

  private createSendParams(toPlayerId: string, message: string): Record<string, unknown> {
    return {
      toPlayerId,
      messageId: randomUUID(),
      message
    }
  }

  private processIncomingMessage(
    msgObj: Record<string, unknown>,
    hostIdStr: string,
    sendSignal: (sig: SignalStructure) => void
  ): void {
    const from = msgObj.From !== undefined ? String(msgObj.From) : ''
    const rawInner = typeof msgObj.Message === 'string' ? msgObj.Message : ''
    const msgId =
      msgObj.Id !== undefined && msgObj.Id !== null ? String(msgObj.Id) : randomUUID()

    const rawMsgDebug = JSON.stringify(msgObj, null, 2)
    this.log.debug(
      `[WebRTC INNER RAW] envelope: ${rawMsgDebug.length > INNER_RAW_MAX ? `${rawMsgDebug.slice(0, INNER_RAW_MAX)}…` : rawMsgDebug}`
    )

    if (!rawInner) return

    let innerJson: Record<string, unknown>
    try {
      innerJson = JSON.parse(rawInner) as Record<string, unknown>
    } catch (e) {
      this.log.debug(`NetherNet: inner message not JSON: ${rawInner.slice(0, 120)}`)
      return
    }

    const innerDbg = JSON.stringify(innerJson, null, 2)
    this.log.debug(
      `[WebRTC INNER RAW] parsed outer JSON: ${innerDbg.length > INNER_RAW_MAX ? `${innerDbg.slice(0, INNER_RAW_MAX)}…` : innerDbg}`
    )

    if (
      typeof innerJson.Code === 'number' &&
      typeof innerJson.Message === 'string' &&
      typeof innerJson.method !== 'string'
    ) {
      this.log.debug(`[JsonRPC RX] ignoring franchise status envelope: ${JSON.stringify(innerJson)}`)
      return
    }

    if (innerJson.method === RPC_INNER_DELIVERY) {
      this.log.debug(
        '[JsonRPC RX] Signaling_DeliveryNotification_v1_0 (delivery ACK only — not WebRTC ICE connected)'
      )
      return
    }

    if (from && isGuid(from)) {
      void this.sendDeliveryAck(from, msgId).catch((e) =>
        this.log.debug(`[WebRTC] DeliveryNotification send failed: ${(e as Error).message}`)
      )
    } else if (from) {
      this.log.debug(`[JsonRPC RX] skipping DeliveryAck — envelope.From is not a player GUID: ${from}`)
    }

    if (innerJson.method !== RPC_INNER_WEBRTC) return

    const params = innerJson.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) return

    const nnRaw = (params as Record<string, unknown>).netherNetId
    if (nnRaw !== undefined && nnRaw !== null && String(nnRaw).trim() !== '') {
      this.lastInnerNetherNetIdFromJsonRpc = String(nnRaw).trim()
    } else {
      this.lastInnerNetherNetIdFromJsonRpc = undefined
    }

    const message = (params as Record<string, unknown>).message
    if (typeof message !== 'string') return

    const payload = message
    const parts = payload.trim().split(/\s+/)
    const t1Head = (parts[0] ?? '').toUpperCase()

    /** Ohne diese Zeile: Franchise sendet kein inneres WebRTC-JSON (falscher Pfad / nicht Minecraft-Bedrock-Join). */
    this.log.debug(`[JsonRPC RX] Signaling_WebRtc_v1_0 message=${t1Head || '?'}`)

    if (this.dumpRawWebRtcUntilOffer && !this.joinOfferCompleted && t1Head !== 'CONNECTREQUEST') {
      this.log.warn(`[WebRTC] raw params.message (signaling before offer finished): ${payload.slice(0, 2500)}`)
    }

    this.log.debug(
      `[WebRTC INNER RAW] WebRtc params.message (${payload.length} B): ${payload.slice(0, Math.min(INNER_RAW_MAX, payload.length))}${payload.length > INNER_RAW_MAX ? '…' : ''}`
    )

    this.log.debug(`NetherNet JsonRPC ← inner (${t1Head || '?'}, ${payload.length} B)`)
    if (t1Head === 'CONNECTREQUEST') {
      this.log.debug(`[JoinTest] CONNECTREQUEST inbound iceReady=${this.gotIceConfig} From=${from || '—'}`)
      this.log.debug(`[JoinTest] CONNECTREQUEST raw line (${payload.length} B): ${payload.slice(0, 480)}`)
    }

    const env: FranchiseEnvelope = { From: from || undefined, Message: payload }
    const envNorm: FranchiseEnvelope = { ...env, Message: payload }

    if (!this.gotIceConfig) {
      this.pendingType1.push(envNorm)
      if (t1Head === 'CONNECTREQUEST') {
        this.log.debug(`[JoinTest] CONNECTREQUEST buffered until TurnAuth queueLen=${this.pendingType1.length}`)
      }
      return
    }

    this.handleFranchiseType1(envNorm, hostIdStr, sendSignal)
  }

  private handleJsonRpcRequest(
    json: Record<string, unknown>,
    hostIdStr: string,
    sendSignal: (sig: SignalStructure) => void
  ): void {
    const method = typeof json.method === 'string' ? json.method : ''
    const id = json.id

    switch (method) {
      case RPC_RECEIVE_MESSAGE: {
        this.log.debug('[JsonRPC RX] Signaling_ReceiveMessage_v1_0')
        if (id !== undefined && id !== null) this.sendJsonRpcResult(id, null)
        const params = json.params
        if (!Array.isArray(params)) return
        for (const el of params) {
          if (el && typeof el === 'object' && !Array.isArray(el)) {
            this.processIncomingMessage(el as Record<string, unknown>, hostIdStr, sendSignal)
          }
        }
        break
      }
      case RPC_PING:
      case RPC_PONG:
        if (id !== undefined && id !== null) this.sendJsonRpcResult(id, null)
        break
      default:
        this.log.debug(`[JsonRPC] request ignored: ${method}`)
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  get lastFranchiseSignalingNetherNetId(): bigint | null {
    return this.franchiseWsNetherNetId
  }

  /** Bodenwahrheit wie {@code new Server({ networkId })} — muss zu {@code session.netherNetId} passieren. */
  get hostNetherNetServerNetworkId(): bigint | null {
    return this.netherServer?.networkId ?? null
  }

  async connect(netherNetId: bigint, mcToken: string, getRelay: () => NetherNetRelayTarget): Promise<void> {
    await this.close()
    this.iceCredentials = []
    this.gotIceConfig = false
    this.pendingType1 = []
    if (this.iceConfigWaitTimer) {
      clearTimeout(this.iceConfigWaitTimer)
      this.iceConfigWaitTimer = null
    }
    if (this.rpcPingInitialTimer) {
      clearTimeout(this.rpcPingInitialTimer)
      this.rpcPingInitialTimer = null
    }
    if (this.rpcPingInterval) {
      clearInterval(this.rpcPingInterval)
      this.rpcPingInterval = null
    }
    this.signalPeerByConnectionId.clear()
    this.lastJoinerFranchiseFrom = undefined
    this.pendingRpc.clear()
    this.pendingCandidatesByConn.clear()
    this.joinOfferCompleted = false
    this.dumpRawWebRtcUntilOffer = false
    this.remoteInnerNetherNetIdByConn.clear()
    this.lastInnerNetherNetIdFromJsonRpc = undefined
    this.joinHandshakeUntil = 0

    this.netherServer = createNetherNetHost({
      networkId: netherNetId,
      log: this.log,
      getRelay
    })

    const hostIdStr = netherNetId.toString()

    this.log.debug(`[JsonRPC] signaling URL ${NETHERNET_JSONRPC_SIGNALING_WS} netherNetId=${hostIdStr}`)

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(NETHERNET_JSONRPC_SIGNALING_WS, {
        headers: {
          Authorization: mcToken,
          'User-Agent': NETHERNET_SIGNALING_USER_AGENT,
          'session-id': randomUUID(),
          'request-id': randomUUID()
        }
      })
      this.ws = ws
      const t = setTimeout(() => {
        reject(new Error('NetherNet signaling connect timeout'))
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }, 15_000)

      const sendOutboundSignal = (sig: SignalStructure): void => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return

        const cid = sig.connectionId.toString()
        /** JsonRPC {@code toPlayerId} = **System.Guid** — immer {@code envelope.From}, nie {@code inner.params.netherNetId}. */
        let routeTo = this.signalPeerByConnectionId.get(cid)
        if (routeTo === undefined && this.lastJoinerFranchiseFrom !== undefined) {
          routeTo = this.lastJoinerFranchiseFrom
        }
        const innerNnMeta = this.remoteInnerNetherNetIdByConn.get(cid)
        if (innerNnMeta !== undefined) {
          this.log.debug(
            `[WebRTC] inner.params.netherNetId=${innerNnMeta} (metadata only — toPlayerId uses envelope From GUID)`
          )
        }
        if (routeTo === undefined) {
          this.log.warn(
            `NetherNet signal outbound ohne To (connection ${sig.connectionId}) — CONNECTRESPONSE/CANDIDATEADD erreichen den Joiner nicht`
          )
          return
        }

        const innerMsg = {
          jsonrpc: '2.0',
          method: RPC_INNER_WEBRTC,
          params: {
            netherNetId: hostIdStr,
            message: sig.toString()
          }
        }
        const innerStr = JSON.stringify(innerMsg)
        const firstTok = sig.toString().trim().split(/\s+/)[0] ?? ''

        this.log.debug(
          `[JsonRPC TX] Signaling_SendClientMessage_v1_0 to=${routeTo} netherNetId=${hostIdStr} message=${firstTok} connectionId=${sig.connectionId} len=${innerStr.length}`
        )

        if (sig.type === SignalType.ConnectResponse) {
          const sdp = typeof sig.data === 'string' ? sig.data : String(sig.data ?? '')
          const lines = sdp
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .slice(0, 8)
            .join(' | ')
          this.log.debug(`[WebRTC] answer sdp firstLines=${lines}`)
        }

        void this.sendJsonRpc(RPC_SEND_MESSAGE, this.createSendParams(routeTo, innerStr)).catch((e) => {
          this.log.warn(`NetherNet JsonRPC SendClientMessage failed: ${(e as Error).message}`)
        })

        if (sig.type === SignalType.ConnectResponse) {
          /** Ohne diese Zeile: {@code handleOffer} hat keine Antwort gesendet oder SendClientMessage/To fehlt. */
          this.log.info('[WebRTC] answer sent')
        }
      }

      ws.on('open', () => {
        clearTimeout(t)
        this.franchiseWsNetherNetId = netherNetId
        this.log.info(`[JsonRPC] connected netherNetId=${hostIdStr}`)
        this.log.debug(
          `[JsonRPC] host NetherNetId bound=${hostIdStr} — Session PUT NetherNetId/WebRTCNetworkId müssen exakt diese ID nutzen (Server.networkId + WS).`
        )
        this.log.debug('[JsonRPC] WebSocket open — TurnAuth + Ping')

        if (this.iceConfigWaitTimer) clearTimeout(this.iceConfigWaitTimer)
        this.iceConfigWaitTimer = setTimeout(() => {
          this.iceConfigWaitTimer = null
          if (this.gotIceConfig) return
          mergeIceServers(this.iceCredentials, [...FALLBACK_ICE_URLS])
          this.log.warn(
            `NetherNet: keine ICE nach TurnAuth innerhalb ${ICE_CONFIG_FALLBACK_MS} ms — Fallback`
          )
          this.gotIceConfig = true
          this.flushPendingType1(hostIdStr, sendOutboundSignal)
        }, ICE_CONFIG_FALLBACK_MS)

        void this.sendJsonRpc(RPC_TURN_AUTH, {})
          .then((result) => {
            this.applyIceFromTurnAuth(result, hostIdStr, sendOutboundSignal)
          })
          .catch((e) => {
            this.log.error('NetherNet TurnAuth failed', e)
          })

        if (this.rpcPingInitialTimer) clearTimeout(this.rpcPingInitialTimer)
        this.rpcPingInitialTimer = setTimeout(() => {
          const pingOnce = () => {
            if (ws.readyState === WebSocket.OPEN) {
              void this.sendJsonRpc(RPC_PING, {}).catch(() => {
                /* ignore */
              })
            }
          }
          pingOnce()
          if (this.rpcPingInterval) clearInterval(this.rpcPingInterval)
          this.rpcPingInterval = setInterval(pingOnce, RPC_PING_PERIOD_MS)
        }, RPC_PING_INITIAL_MS)

        resolve()
      })

      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        let json: Record<string, unknown>
        try {
          json = JSON.parse(text) as Record<string, unknown>
        } catch {
          this.log.debug(`NetherNet non-JSON frame: ${text.slice(0, 120)}`)
          return
        }

        const hasId = json.id !== undefined && json.id !== null
        if (hasId && (json.result !== undefined || json.error !== undefined)) {
          this.handleJsonRpcResponse(json)
          return
        }

        if (typeof json.method === 'string') {
          this.handleJsonRpcRequest(json, hostIdStr, sendOutboundSignal)
        }
      })

      ws.on('error', (err) => {
        clearTimeout(t)
        this.log.error('NetherNet signaling error', err)
        reject(err)
      })

      ws.on('close', () => {
        if (this.rpcPingInterval) {
          clearInterval(this.rpcPingInterval)
          this.rpcPingInterval = null
        }
        if (this.rpcPingInitialTimer) {
          clearTimeout(this.rpcPingInitialTimer)
          this.rpcPingInitialTimer = null
        }
        this.rpcFailCleanup()
        this.log.debug('NetherNet JsonRPC WebSocket closed')
      })
    })
  }

  async close(): Promise<void> {
    if (this.iceConfigWaitTimer) {
      clearTimeout(this.iceConfigWaitTimer)
      this.iceConfigWaitTimer = null
    }
    if (this.rpcPingInitialTimer) {
      clearTimeout(this.rpcPingInitialTimer)
      this.rpcPingInitialTimer = null
    }
    if (this.rpcPingInterval) {
      clearInterval(this.rpcPingInterval)
      this.rpcPingInterval = null
    }
    this.pendingType1 = []
    this.pendingCandidatesByConn.clear()
    this.rpcFailCleanup()

    if (this.netherServer) {
      for (const c of this.netherServer.connections.values()) {
        try {
          c.close()
        } catch {
          /* ignore */
        }
      }
      this.netherServer.connections.clear()
      this.netherServer.removeAllListeners()
      this.netherServer = null
    }

    if (!this.ws) {
      this.franchiseWsNetherNetId = null
      return
    }
    await new Promise<void>((resolve) => {
      const w = this.ws!
      w.once('close', () => resolve())
      try {
        w.close()
      } catch {
        resolve()
      }
      this.ws = null
    })
    this.franchiseWsNetherNetId = null
  }
}
