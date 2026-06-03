import type { Logger } from '../core/logger'

export type PingResult = {
  motd: string
  subMotd: string
  playerCount: number
  maxPlayers: number
  protocolVersion?: number
}

/**
 * Ping Bedrock server via {@code bedrock-protocol}; optional Geyser checker fallback.
 */
export async function pingBedrock(
  host: string,
  port: number,
  log: Logger,
  webFallback: boolean
): Promise<PingResult> {
  try {
    const { ping } = await import('bedrock-protocol')
    const res = await ping({ host, port })
    return {
      motd: String(res.motd ?? ''),
      subMotd: String(res.levelName ?? ''),
      playerCount: Number(res.playersOnline ?? 0),
      maxPlayers: Number(res.playersMax ?? 0),
      protocolVersion: res.protocol !== undefined ? Number(res.protocol) : undefined
    }
  } catch (e) {
    log.debug(`Native ping failed: ${(e as Error).message}`)
    if (!webFallback) throw e
    return webPingChecker(host, port)
  }
}

async function webPingChecker(host: string, port: number): Promise<PingResult> {
  const url = `https://checker.geysermc.org/ping?hostname=${encodeURIComponent(host)}&port=${port}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`WebAPI: HTTP ${res.status}`)
  const data = (await res.json()) as {
    success: boolean
    ping?: { pong?: Record<string, unknown> }
  }
  if (!data.success) throw new Error('WebAPI: Server is offline')
  const pong = data.ping?.pong
  if (!pong || typeof pong !== 'object') throw new Error('WebAPI: invalid pong')
  return {
    motd: String((pong as any).motd ?? ''),
    subMotd: String((pong as any).subMotd ?? (pong as any).levelName ?? ''),
    playerCount: Number((pong as any).playerCount ?? 0),
    maxPlayers: Number((pong as any).maximumPlayerCount ?? (pong as any).maxPlayers ?? 0),
    protocolVersion:
      (pong as any).protocolVersion !== undefined ? Number((pong as any).protocolVersion) : undefined
  }
}
