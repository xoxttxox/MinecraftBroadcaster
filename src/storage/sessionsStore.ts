import fs from 'fs'
import { CACHE_DIR, SESSIONS_CACHE_FILE } from '../core/paths'

/**
 * Persistente Runtime-/Session-Metadaten (nicht Auth-Token — siehe {@link AUTH_CACHE_FILE}).
 */
export type SessionsRuntimeCache = {
  /** ISO-Zeitpunkt des letzten Prozessstarts */
  lastProcessStartIso?: string
  lastSessionId?: string
  lastConnectionId?: string
  /** {@link ExpandedSessionInfo.netherNetId} als Dezimalstring */
  lastNetherNetIdStr?: string
  lastSubscriptionId?: string
}

function readRoot(): SessionsRuntimeCache {
  try {
    if (!fs.existsSync(SESSIONS_CACHE_FILE)) return {}
    const raw = fs.readFileSync(SESSIONS_CACHE_FILE, 'utf8')
    const j = JSON.parse(raw) as unknown
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as SessionsRuntimeCache) : {}
  } catch {
    return {}
  }
}

export function readSessionsRuntime(): SessionsRuntimeCache {
  return readRoot()
}

export function mergeSessionsRuntime(patch: SessionsRuntimeCache): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const cur = readRoot()
  fs.writeFileSync(SESSIONS_CACHE_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8')
}
