import fs from 'fs'
import path from 'path'
import { BedrockAuthService } from '../auth/bedrockAuth'
import {
  type CoreConfigYaml,
  loadConfig,
  resolveAuthDeviceProfile,
  resolveMicrosoftAuthFlow
} from '../config/config'
import { initFileLogging } from '../core/fileLogging'
import { Logger } from '../core/logger'
import {
  AUTH_CACHE_FILE,
  CACHE_DIR,
  LOGS_DIR,
  PLAYER_HISTORY_DB,
  SESSIONS_CACHE_FILE
} from '../core/paths'
import { ExpandedSessionInfo, type SessionInfo } from '../session/expandedSessionInfo'
import { XboxSessionController } from '../session/xboxSessionController'
import { FriendSync } from '../social/friends'
import { notifySessionExpired } from '../services/notifications'
import { migrateLegacyCacheJson } from '../storage/migrateCache'
import { mergeSessionsRuntime } from '../storage/sessionsStore'
import { migrateLegacyPrismarineCaches } from '../storage/unifiedPrismarineCache'
import { PlayerHistoryDb } from '../storage/playerHistory'
import { pingBedrock } from '../services/bedrockPing'

const { Versions, CURRENT_VERSION } = require('bedrock-protocol/src/options') as {
  Versions: Record<string, number>
  CURRENT_VERSION: string
}

const CONFIG_PATH = path.resolve(process.cwd(), 'config.yml')

export async function runStandalone(): Promise<void> {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.mkdirSync(LOGS_DIR, { recursive: true })
  initFileLogging(LOGS_DIR)
  const log = new Logger('Standalone')
  const { config: cfg, createdNewFile } = loadConfig(CONFIG_PATH, log)
  log.setDebug(cfg.debugMode === true)

  if (createdNewFile) {
    log.info(
      'Bitte config.yml einrichten (z. B. session.sessionInfo ip/port, bedrockVersion, auth) und das Programm danach erneut starten.'
    )
    process.exit(0)
  }

  const bedrockVer = cfg.bedrockVersion || CURRENT_VERSION
  if (!Versions[bedrockVer]) {
    log.error(`Unsupported bedrockVersion "${bedrockVer}" — check bedrock-protocol supported releases.`)
    process.exit(1)
  }

  migrateLegacyCacheJson(log)
  migrateLegacyPrismarineCaches(CACHE_DIR, AUTH_CACHE_FILE, log)
  mergeSessionsRuntime({ lastProcessStartIso: new Date().toISOString() })

  const authProfile = resolveAuthDeviceProfile(cfg)
  const msFlow = resolveMicrosoftAuthFlow(cfg, authProfile)
  log.info(
    `Microsoft login: ${authProfile} / ${msFlow} — Auth: ${AUTH_CACHE_FILE}, Sessions: ${SESSIONS_CACHE_FILE}, Freunde: ${PLAYER_HISTORY_DB}`
  )

  const auth = new BedrockAuthService(
    log.prefixed('Auth'),
    bedrockVer,
    authProfile,
    msFlow,
    async (uri, code) => {
      log.info(`To sign in, open ${uri} and enter code ${code}`)
      await notifySessionExpired(cfg, log, uri, code)
    }
  )

  const xbox = await auth.getXboxToken()
  log.info(`Authenticated as XUID ${xbox.userXUID}`)

  const baseInfo: SessionInfo = {
    hostName: cfg.session?.sessionInfo?.hostName ?? '',
    worldName: cfg.session?.sessionInfo?.worldName ?? '',
    worldType: cfg.session?.sessionInfo?.worldType,
    players: cfg.session?.sessionInfo?.players ?? 0,
    maxPlayers: cfg.session?.sessionInfo?.maxPlayers ?? 20,
    ip: cfg.session?.sessionInfo?.ip ?? '127.0.0.1',
    port: cfg.session?.sessionInfo?.port ?? 19132
  }

  let expanded = new ExpandedSessionInfo(baseInfo)
  expanded.updateFrom(baseInfo, Versions[bedrockVer], bedrockVer)
  expanded.extraWebRtcSignalingConnection = cfg.session?.extraWebRtcSignalingConnection !== false
  expanded.onlyWebRtcSignalingConnection = cfg.session?.onlyWebRtcSignalingConnection === true
  expanded.transportLayer = cfg.session?.transportLayer ?? 2
  expanded.broadcastSetting = cfg.session?.broadcastSetting ?? 3

  const history = new PlayerHistoryDb(PLAYER_HISTORY_DB)

  const schedule = (fn: () => void, delayMs: number, periodMs: number) => {
    setTimeout(() => {
      fn()
      setInterval(fn, periodMs)
    }, delayMs)
  }

  const friends = new FriendSync(
    async () => xblHeader(auth),
    log.prefixed('Friends'),
    history,
    schedule
  )

  let controller: XboxSessionController | null = null

  const fullRefreshIntervalSec = Number(cfg.session?.fullRefreshInterval ?? 0)
  const fullRefreshIntervalMs = Number.isFinite(fullRefreshIntervalSec) && fullRefreshIntervalSec > 0
    ? fullRefreshIntervalSec * 1000
    : 0

  const rtaReconnectAttemptsRaw = Number(cfg.session?.rtaReconnectAttempts ?? 3)
  const rtaReconnectAttempts = Number.isFinite(rtaReconnectAttemptsRaw) && rtaReconnectAttemptsRaw > 0
    ? Math.floor(rtaReconnectAttemptsRaw)
    : 3

  const rtaReconnectDelaySec = Number(cfg.session?.rtaReconnectDelay ?? 3)
  const rtaReconnectDelayMs = Number.isFinite(rtaReconnectDelaySec) && rtaReconnectDelaySec > 0
    ? Math.floor(rtaReconnectDelaySec * 1000)
    : 0

  const startPresenceLoop = () => {
    const run = async () => {
      if (!controller?.initialized) {
        setTimeout(run, 5_000)
        return
      }
      await controller.schedulePresence(run)
    }
    void run()
  }

  const buildController = () =>
    new XboxSessionController(
      auth,
      log.prefixed('Session'),
      expanded,
      async () => {
        try {
          await controller?.updateNonces()
          /** RTA Session-Network: Nonces ändern sich — sofort publizieren (nicht erst beim Interval). */
          if (controller?.initialized) await controller.putSession()
        } catch (e) {
          log.error('Nonce refresh failed', e)
        }
      },
      () => {
        void friends.acceptPendingFriendRequests()
      },
      cfg.notifications,
      history,
      async (reason) => {
        mergeSessionsRuntime({
          lastSessionId: expanded.sessionId,
          lastConnectionId: expanded.connectionId,
          lastNetherNetIdStr: expanded.netherNetId.toString(),
          lastSubscriptionId: expanded.subscriptionId
        })
        log.info(`Session runtime cache updated after full rotation (${reason})`)
      },
      fullRefreshIntervalMs,
      rtaReconnectAttempts,
      rtaReconnectDelayMs
    )

  controller = buildController()
  friends.getSessionId = () => expanded.sessionId

  await refreshSessionInfoFromPing(cfg, baseInfo, expanded, log, auth, bedrockVer)
  if (!expanded.getHostName()) {
    const x2 = await auth.getXboxToken()
    expanded.updateFrom(
      { ...baseInfo, hostName: `Player ${x2.userXUID}` },
      Versions[bedrockVer],
      bedrockVer
    )
  }

  await controller.createFullSession()
  mergeSessionsRuntime({
    lastSessionId: expanded.sessionId,
    lastConnectionId: expanded.connectionId,
    lastNetherNetIdStr: expanded.netherNetId.toString(),
    lastSubscriptionId: expanded.subscriptionId
  })
  log.info('Xbox Live session created successfully (NetherNet signaling + WebRTC + Bedrock-Redirect aktiv)')
  log.info(
    expanded.onlyWebRtcSignalingConnection
      ? 'Session directory: nur WebRTC signaling (3) — session.onlyWebRtcSignalingConnection: true (Test)'
      : `Session directory: ${expanded.extraWebRtcSignalingConnection ? 'JsonRpc + WebRTC (Standard)' : 'nur JsonRpc (session.extraWebRtcSignalingConnection: false)'}`
  )
  log.info(
    'Freundes-Join: bedrockVersion wie beim Joiner; session.sessionInfo.ip/port = Bedrock/Geyser nach NetherNet-Transfer.'
  )
  if (cfg.debugMode === true) {
    log.debug(
      'Join-Details: Cross-Play an (OnlineCrossPlatformGame); PC/Switch/Handy nutzen oft WebRTC-Zeile — session.extraWebRtcSignalingConnection (Standard: true).'
    )
  }

  friends.init(cfg.friendSync, cfg.notifications)
  void friends.acceptPendingFriendRequests()

  startPresenceLoop()

  if (fullRefreshIntervalMs > 0) {
    log.info(`Full session refresh watchdog: every ${Math.round(fullRefreshIntervalMs / 1000)}s`)
  } else {
    log.info('Full session refresh watchdog is disabled (session.fullRefreshInterval <= 0) — RTA uses soft reconnect first')
  }

  log.info(
    `RTA reconnect strategy: soft reconnect ${rtaReconnectAttempts} attempt(s), delay ${Math.round(rtaReconnectDelayMs / 1000)}s; full rotation only after failed soft reconnect or hard session errors`
  )

  const updateEvery = (cfg.session?.updateInterval ?? 30) * 1000
  setInterval(async () => {
    try {
      await refreshSessionInfoFromPing(cfg, baseInfo, expanded, log, auth, bedrockVer)
      /** Während Session-Neuaufbau kein PUT (kurzes Fenster nach Shutdown). */
      if (controller?.initialized) {
        await controller.maybeProactiveFullRefresh()
        await controller.checkConnection()
        /** Ohne regelmäßiges GET→Nonce-Sync verpassen wir Joiner, wenn RTA kein „Session Network“ sendet. */
        await controller.updateNonces()
        await controller.putSession()
      }
      if (!cfg.suppressSessionUpdateMessage) log.info('Updated session!')
      else log.debug('Updated session!')
    } catch (e) {
      log.error('Session update failed', e)
    }
  }, updateEvery)

  const sum = await controller.socialSummary()
  const fc = friends.followerSummary()
  log.info(`Friend sync: following ${sum.targetFollowingCount}/${fc.max}`)
}

async function xblHeader(auth: BedrockAuthService): Promise<string> {
  const x = await auth.getXboxToken()
  return `XBL3.0 x=${x.userHash};${x.XSTSToken}`
}

async function refreshSessionInfoFromPing(
  cfg: CoreConfigYaml,
  base: SessionInfo,
  expanded: ExpandedSessionInfo,
  log: Logger,
  auth: BedrockAuthService,
  bedrockVer: string
): Promise<void> {
  if (!cfg.session?.queryServer) return
  try {
    const pong = await pingBedrock(base.ip, base.port, log, cfg.session.webQueryFallback === true)
    base.hostName = pong.subMotd
    base.worldName = pong.motd
    base.players = pong.playerCount
    base.maxPlayers = pong.maxPlayers
    const proto = pong.protocolVersion ?? Versions[bedrockVer]
    expanded.updateFrom(base, proto, bedrockVer)
    if (!expanded.getHostName()) {
      const x = await auth.getXboxToken()
      expanded.updateFrom({ ...base, hostName: `Player ${x.userXUID}` }, proto, bedrockVer)
    }
  } catch (e) {
    if (cfg.session.configFallback) {
      log.error('Ping failed, using config sessionInfo', e)
      const si = cfg.session.sessionInfo
      base.hostName = si?.hostName ?? base.hostName
      base.worldName = si?.worldName ?? base.worldName
      base.worldType = si?.worldType ?? base.worldType
      base.players = si?.players ?? base.players
      base.maxPlayers = si?.maxPlayers ?? base.maxPlayers
      expanded.updateFrom(base, Versions[bedrockVer], bedrockVer)
    } else {
      log.error('Ping failed', e)
    }
  }
}
