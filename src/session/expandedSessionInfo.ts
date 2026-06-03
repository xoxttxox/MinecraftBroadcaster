import { randomBytes, randomUUID } from 'crypto'

/** Upper bound exclusive for NetherNet id so JSON.stringify keeps integer precision (Java uses long + Gson). */
const NETHERNET_ID_MAX_EXCLUSIVE = 9007199254740992n // Number.MAX_SAFE_INTEGER + 1

function randomNetherNetIdSafe(): bigint {
  let v = 0n
  while (v === 0n) {
    const buf = randomBytes(8)
    v = buf.readBigUInt64LE(0) % NETHERNET_ID_MAX_EXCLUSIVE
  }
  return v
}

export interface SessionInfo {
  hostName: string
  worldName: string
  /** Xbox session directory; default Survival. */
  worldType?: string
  players: number
  maxPlayers: number
  ip: string
  port: number
}

/** Values shown in Minecraft „Welten“ / friend join UI (SessionCustomProperties.worldType). */
export function canonicalWorldType(raw: string | undefined): string {
  if (!raw?.trim()) return 'Survival'
  const m = raw.trim().toLowerCase()
  if (m === 'creative') return 'Creative'
  if (m === 'adventure') return 'Adventure'
  if (m === 'survival') return 'Survival'
  return raw.trim()
}

const COLOR = /\u00A7[\dA-FK-ORa-fk-or]/g

function stripColor(s: string): string {
  return s.replace(COLOR, '')
}

function clampPlayers(p: number): number {
  return p <= 0 ? 1 : p
}

function clampMax(max: number, players: number): number {
  const pl = clampPlayers(players)
  if (max <= pl) return pl + 1
  return max
}

export class ExpandedSessionInfo {
  connectionId = ''
  xuid = ''
  rakNetGuid = ''
  sessionId: string
  handleId: string | undefined
  /** Host-NetherNet-ID: nur Konstruktor + {@link rotateIdentity}; nie mitten im Lauf ändern ohne Signaling-Neuaufbau. */
  private _netherNetId: bigint
  /** RTA/subscription — stabil über alle Session-PUTs einer Identität; neu bei {@link rotateIdentity}. */
  private _subscriptionId: string
  readonly deviceId: string
  pmsgId: string | undefined
  /**
   * Second SupportedConnections row for some mobile clients — off by default (matches Java broadcaster).
   */
  extraWebRtcSignalingConnection = false
  /**
   * Nur WebSocketsWebRTCSignaling (3) + WebRTCNetworkId — zum Testen ohne JsonRpc-Zeile.
   */
  onlyWebRtcSignalingConnection = false

  /** Session directory custom.TransportLayer */
  transportLayer = 2
  /** Session directory custom.BroadcastSetting */
  broadcastSetting = 3

  private hostName: string
  private worldName: string
  private worldType: string
  private players: number
  private maxPlayers: number
  private ip: string
  private port: number

  constructor(base: SessionInfo) {
    this.sessionId = randomUUID()
    /** Same role as Java {@code BigInteger.valueOf(Math.abs(RANDOM.nextLong()))}, constrained for exact JSON numbers in Node. */
    this._netherNetId = randomNetherNetIdSafe()
    this._subscriptionId = randomUUID()
    this.deviceId = randomUUID()
    this.hostName = base.hostName || 'MCXboxBroadcast'
    this.worldName = base.worldName || this.hostName
    this.worldType = canonicalWorldType(base.worldType)
    this.players = base.players
    this.maxPlayers = base.maxPlayers
    this.ip = base.ip
    this.port = base.port
  }

  get netherNetId(): bigint {
    return this._netherNetId
  }

  /** Feste subscription.id im Session-PUT — nicht bei jedem PUT neu würfeln. */
  get subscriptionId(): string {
    return this._subscriptionId
  }

  updateFrom(base: SessionInfo, protocolVersion: number, versionName: string): void {
    this.hostName = stripColor(base.hostName || 'MCXboxBroadcast')
    this.worldName = stripColor(base.worldName || this.hostName)
    this.worldType = canonicalWorldType(base.worldType ?? this.worldType)
    this.players = base.players
    this.maxPlayers = base.maxPlayers
    this.ip = base.ip
    this.port = base.port
    this._protocolVersion = protocolVersion
    this._versionName = versionName
  }

  private _protocolVersion = 0
  private _versionName = ''

  getProtocol(): number {
    return this._protocolVersion
  }

  getVersion(): string {
    return this._versionName
  }

  getHostName(): string {
    return this.hostName
  }

  getWorldName(): string {
    return this.worldName
  }

  getWorldType(): string {
    return this.worldType
  }

  getPlayers(): number {
    return clampPlayers(this.players)
  }

  getMaxPlayers(): number {
    return clampMax(this.maxPlayers, this.players)
  }

  getIp(): string {
    return this.ip
  }

  getPort(): number {
    return this.port
  }

  getTransportLayer(): number {
    return this.transportLayer
  }

  getBroadcastSetting(): number {
    return this.broadcastSetting
  }

  /** NetherNet id as JSON number for session PUT (must be ≤ MAX_SAFE_INTEGER). */
  netherNetIdJsonNumber(): number {
    return Number(this.netherNetId)
  }

  /**
   * Neue Xbox-Session + neue NetherNet-ID (nur gemeinsam mit vollem Shutdown und neuem {@code NetherNet.connect}
   * aufrufen — sonst stimmen PUT und JsonRPC-Host nicht überein).
   */
  rotateIdentity(): void {
    this.sessionId = randomUUID()
    this._netherNetId = randomNetherNetIdSafe()
    this._subscriptionId = randomUUID()
    this.connectionId = ''
    this.handleId = undefined
    this.pmsgId = undefined
  }
}
