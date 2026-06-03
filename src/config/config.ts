import fs from 'fs'
import path from 'path'
import yaml from 'yaml'
import type { Logger } from '../core/logger'

export interface SessionInfoYaml {
  hostName?: string
  worldName?: string
  /**
   * Xbox-Freundesliste / „Welten“: Survival | Creative | Adventure (nur Anzeige im Session-Directory, nicht vom Server gelesen).
   */
  worldType?: string
  players?: number
  maxPlayers?: number
  ip?: string
  port?: number
}

export interface SessionYaml {
  remoteAddress?: string
  remotePort?: string
  updateInterval?: number
  /** Sekunden bis zu einer kompletten neuen Xbox-Session/NetherNet/RTA-Rotation. 0 deaktiviert. */
  fullRefreshInterval?: number
  /** RTA/WebSocket erst soft neu verbinden, bevor eine neue Xbox-Session erstellt wird. */
  rtaReconnectAttempts?: number
  /** Sekunden Pause zwischen RTA Soft-Reconnect-Versuchen. */
  rtaReconnectDelay?: number
  /** Session directory custom.TransportLayer (default 2). */
  transportLayer?: number
  /** Session directory custom.BroadcastSetting (default 3). */
  broadcastSetting?: number
  queryServer?: boolean
  webQueryFallback?: boolean
  configFallback?: boolean
  /**
   * If true (default), session directory includes JsonRpc (7) + WebRTC signaling (3). Set false for Java-only payload.
   */
  extraWebRtcSignalingConnection?: boolean
  /**
   * Test: nur eine SupportedConnections-Zeile — ConnectionType 3 + WebRTCNetworkId (kein JsonRpc 7 / NetherNetId).
   * Overrides {@link extraWebRtcSignalingConnection}.
   */
  onlyWebRtcSignalingConnection?: boolean
  sessionInfo?: SessionInfoYaml
}

export interface FriendExpiryYaml {
  enabled?: boolean
  days?: number
  check?: number
}

export interface FriendSyncYaml {
  updateInterval?: number
  autoFollow?: boolean
  autoUnfollow?: boolean
  /**
   * Eingehende Freundschaftsanfragen per API annehmen (PeopleHub + bulk add).
   * Standard: wie {@link autoFollow} — bei {@code autoFollow: false} läuft das sonst nicht → kein {@link NotificationsYaml.friendRequestAcceptedMessage}.
   */
  autoAcceptIncomingFriendRequests?: boolean
  initialInvite?: boolean
  expiry?: FriendExpiryYaml
}

export interface NotificationsYaml {
  enabled?: boolean
  webhookUrl?: string
  sessionExpiredMessage?: string
  friendRestrictionMessage?: string
  /** First %s = gamertag, second %s = XUID */
  friendAddedMessage?: string
  /** First %s = gamertag, second %s = XUID (manual unfollow / autoUnfollow) */
  friendRemovedMessage?: string
  /** First %s = gamertag, second %s = XUID (incoming request accepted) */
  friendRequestAcceptedMessage?: string
  /** Single %s = XUID (removed by friend expiry — gamertag often unknown) */
  friendExpiryRemovalMessage?: string
  /**
   * Discord: Embeds statt reiner `text`-Zeile (nur bei discord.com Webhooks).
   * Standard: true. Bei false oder Nicht-Discord-URL → klassischer Text.
   */
  discordEmbeds?: boolean
  /** Optional: angezeigter Webhook-Name (Discord). */
  discordWebhookUsername?: string
  /** Embed-Fußzeile (klein grau). Standard: MCXboxBroadcast */
  embedFooterText?: string
}

/**
 * Microsoft device-code flow pretends to be a specific Minecraft client.
 * If login fails with “try a different device”, switch profile and delete ./cache before retrying.
 * {@code windows} = intern wie {@code android} (Android-Titel + Android-Gerät); **kein** Win32-Paar — sonst 400 bei Xbox.
 */
export type AuthDeviceProfile = 'nintendo' | 'android' | 'ios' | 'playstation' | 'windows'

/**
 * {@code live}: User + Device + Title-Token (getTitleToken). {@code sisu}: ein Sisu-Schritt (wie viele Xbox-Mobile-Apps).
 * Manche Titel liefern bei live einen **400** auf Title-Auth — dann {@code sisu} oder {@code auto}.
 */
export type AuthMicrosoftFlow = 'live' | 'sisu' | 'auto'

export interface AuthYaml {
  deviceProfile?: AuthDeviceProfile
  /** Default auto: nur Nintendo nutzt live; android/ios/playstation/windows nutzen sisu. */
  microsoftAuthFlow?: AuthMicrosoftFlow
}

export interface CoreConfigYaml {
  session?: SessionYaml
  friendSync?: FriendSyncYaml
  notifications?: NotificationsYaml
  auth?: AuthYaml
  debugMode?: boolean
  suppressSessionUpdateMessage?: boolean
  configVersion?: number
  /** Bedrock version string for auth + ping (e.g. 1.26.20) */
  bedrockVersion?: string
}

const defaults: CoreConfigYaml = {
  session: {
    updateInterval: 30,
    fullRefreshInterval: 0,
    rtaReconnectAttempts: 3,
    rtaReconnectDelay: 3,
    transportLayer: 2,
    broadcastSetting: 3,
    queryServer: true,
    webQueryFallback: false,
    configFallback: false,
    /** Many Bedrock builds lesen WebRTCNetworkId (Typ 3); JsonRpc (7) allein reicht oft nicht. */
    extraWebRtcSignalingConnection: true,
    sessionInfo: {
      hostName: 'Geyser Test Server',
      worldName: 'GeyserMC Demo & Test Server',
      worldType: 'Survival',
      players: 0,
      maxPlayers: 20,
      ip: 'test.geysermc.org',
      port: 19132
    }
  },
  friendSync: {
    updateInterval: 60,
    autoFollow: true,
    autoUnfollow: true,
    initialInvite: true,
    expiry: { enabled: true, days: 15, check: 1800 }
  },
  notifications: {
    enabled: false,
    webhookUrl: '',
    sessionExpiredMessage:
      '@here Xbox Session expired, sign in again to update it.\n\nUse the following link to sign in: %s\nEnter the code: %s',
    friendRestrictionMessage:
      '%s (%s) has restrictions in place that prevent them from being friends with our account.',
    friendAddedMessage: '%s (%s) was added as a friend.',
    friendRemovedMessage: '%s (%s) was removed from friends.',
    friendRequestAcceptedMessage: 'Accepted friend request from %s (%s).',
    friendExpiryRemovalMessage: '%s was removed from friends (inactive / expiry).',
    discordEmbeds: true,
    embedFooterText: 'MCXboxBroadcast'
  },
  auth: {
    deviceProfile: 'nintendo'
  },
  debugMode: false,
  suppressSessionUpdateMessage: false,
  bedrockVersion: '1.26.20',
  configVersion: 2
}

function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base }
  for (const k of Object.keys(patch)) {
    const pv = (patch as any)[k]
    if (pv === undefined) continue
    const bv = (out as any)[k]
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      ;(out as any)[k] = deepMerge(bv, pv)
    } else {
      ;(out as any)[k] = pv
    }
  }
  return out as T
}

const CONFIG_FILE_HEADER = `# MCXboxBroadcast (Node) — automatically created on first start.
# Edit session.sessionInfo (ip / port) and bedrockVersion for your setup.
# Login issues: set auth.deviceProfile …; bei Title-Token 400: auth.microsoftAuthFlow: sisu (oder auto). Dann cache/auth.json löschen (oder gesamten Ordner cache/).

`

const VALID_AUTH_PROFILES: ReadonlySet<string> = new Set([
  'nintendo',
  'android',
  'ios',
  'playstation',
  'windows'
])

const VALID_MS_FLOWS: ReadonlySet<string> = new Set(['live', 'sisu', 'auto'])

export function resolveAuthDeviceProfile(cfg: CoreConfigYaml): AuthDeviceProfile {
  const p = cfg.auth?.deviceProfile
  if (p && VALID_AUTH_PROFILES.has(p)) return p
  return 'nintendo'
}

/** Erzwungen {@code live}/{@code sisu} oder {@code auto}: Nintendo → live, alle anderen Profile → sisu. */
export function resolveMicrosoftAuthFlow(cfg: CoreConfigYaml, profile: AuthDeviceProfile): 'live' | 'sisu' {
  const raw = cfg.auth?.microsoftAuthFlow
  if (raw === 'live' || raw === 'sisu') return raw
  if (raw === 'auto' || raw === undefined) {
    return profile === 'nintendo' ? 'live' : 'sisu'
  }
  return profile === 'nintendo' ? 'live' : 'sisu'
}

export interface LoadConfigResult {
  config: CoreConfigYaml
  /** True wenn gerade eine neue {@code config.yml} geschrieben wurde (first run). */
  createdNewFile: boolean
}

export function loadConfig(filePath: string, log: Logger): LoadConfigResult {
  const full = path.resolve(filePath)
  if (!fs.existsSync(full)) {
    const dir = path.dirname(full)
    if (dir !== '.' && dir !== '') {
      fs.mkdirSync(dir, { recursive: true })
    }
    const initial = deepMerge(defaults, {})
    const body = yaml.stringify(initial, { lineWidth: 120, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' })
    fs.writeFileSync(full, CONFIG_FILE_HEADER + body, 'utf8')
    log.info(`Created default config: ${full}`)
    return { config: initial, createdNewFile: true }
  }
  const raw = fs.readFileSync(full, 'utf8')
  const parsed = yaml.parse(raw) as CoreConfigYaml
  const merged = deepMerge(defaults, parsed || {})
  /** Entfernt veraltete Schlüssel aus älteren config.yml (wird nicht mehr gemerged). */
  delete (merged as Record<string, unknown>).welcome
  if (parsed?.auth?.deviceProfile && !VALID_AUTH_PROFILES.has(parsed.auth.deviceProfile)) {
    log.warn(
      `Invalid auth.deviceProfile "${parsed.auth.deviceProfile}" — using nintendo. Valid: nintendo, android, ios, playstation, windows`
    )
  }
  if (parsed?.auth?.microsoftAuthFlow && !VALID_MS_FLOWS.has(parsed.auth.microsoftAuthFlow)) {
    log.warn(
      `Invalid auth.microsoftAuthFlow "${parsed.auth.microsoftAuthFlow}" — using auto. Valid: live, sisu, auto`
    )
  }
  return { config: merged, createdNewFile: false }
}
