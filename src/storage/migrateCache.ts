import fs from 'fs'
import {
  AUTH_CACHE_FILE,
  CACHE_DIR,
  LEGACY_CACHE_JSON,
  SESSIONS_CACHE_FILE
} from '../core/paths'
import type { Logger } from '../core/logger'

/** Prismarine unified namespaces + legacy fragment names (same as {@link unifiedPrismarineCache}). */
const AUTH_NAMESPACE_KEY = /^[a-f0-9]{6}_(live|sisu|msal|xbl|bed|mca|mcs|pfb)$/i

function readJsonObject(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw) as unknown
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Migriert legacy {@code cache/cache.json}: Auth-Keys → {@code auth.json}, übrige Keys → {@code sessions.json}.
 * Löscht {@code cache.json} nach erfolgreicher Aufteilung.
 */
export function migrateLegacyCacheJson(log: Logger): void {
  if (!fs.existsSync(LEGACY_CACHE_JSON)) return

  let root: Record<string, unknown>
  try {
    const raw = fs.readFileSync(LEGACY_CACHE_JSON, 'utf8')
    const j = JSON.parse(raw) as unknown
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      log.warn('Cache: cache.json hat unerwartetes Format — wird nicht migriert')
      return
    }
    root = j as Record<string, unknown>
  } catch (e) {
    log.warn(`Cache: cache.json konnte nicht gelesen werden — ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  const authPart: Record<string, unknown> = {}
  const sessionPart: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(root)) {
    if (AUTH_NAMESPACE_KEY.test(k)) authPart[k] = v
    else sessionPart[k] = v
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true })

  const authExisting = readJsonObject(AUTH_CACHE_FILE)
  fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify({ ...authExisting, ...authPart }, null, 2), 'utf8')

  if (Object.keys(sessionPart).length > 0) {
    const sessExisting = readJsonObject(SESSIONS_CACHE_FILE)
    fs.writeFileSync(SESSIONS_CACHE_FILE, JSON.stringify({ ...sessExisting, ...sessionPart }, null, 2), 'utf8')
  }

  try {
    fs.unlinkSync(LEGACY_CACHE_JSON)
    log.info('Cache: cache.json nach auth.json / sessions.json migriert und entfernt')
  } catch (e) {
    log.warn(`Cache: cache.json konnte nicht gelöscht werden — ${e instanceof Error ? e.message : String(e)}`)
  }
}
