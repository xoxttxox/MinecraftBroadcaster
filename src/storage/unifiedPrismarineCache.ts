import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Cache, CacheFactory } from 'prismarine-auth'
import type { Logger } from '../core/logger'

/** Wie prismarine-auth {@code createHash(username)} — 6 hex-Zeichen. */
export function prismarineUserHash(username: string): string {
  return crypto.createHash('sha1').update(username ?? '', 'binary').digest('hex').substring(0, 6)
}

const LEGACY_CACHE_RE = /^([a-f0-9]{6})_(live|sisu|msal|xbl|bed|mca|mcs|pfb)-cache\.json$/i

/**
 * Alle prismarine-auth-Token in **einer** Datei {@code cache/auth.json} (Schlüssel {@code <hash>_<cacheName>}).
 * Keine Dutzend {@code *-cache.json}-Fragmente mehr — konsolidiert wie die Java-Standalone cache.json.
 */
class UnifiedAuthFileCache implements Cache {
  private mem: Record<string, unknown> | undefined

  constructor(
    private readonly rootPath: string,
    private readonly namespace: string
  ) {}

  private readRoot(): Record<string, unknown> {
    try {
      if (!fs.existsSync(this.rootPath)) return {}
      const raw = fs.readFileSync(this.rootPath, 'utf8')
      const j = JSON.parse(raw) as unknown
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  private writeRoot(root: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.rootPath), { recursive: true })
    fs.writeFileSync(this.rootPath, JSON.stringify(root, null, 2), 'utf8')
  }

  async reset(): Promise<void> {
    const root = this.readRoot()
    root[this.namespace] = {}
    this.mem = {}
    this.writeRoot(root)
  }

  async getCached(): Promise<Record<string, unknown>> {
    if (this.mem !== undefined) return this.mem
    const root = this.readRoot()
    const section = root[this.namespace]
    this.mem =
      section !== undefined && typeof section === 'object' && !Array.isArray(section)
        ? (section as Record<string, unknown>)
        : {}
    return this.mem
  }

  async setCached(value: unknown): Promise<void> {
    const root = this.readRoot()
    const v =
      value !== undefined && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    root[this.namespace] = v
    this.mem = v
    this.writeRoot(root)
  }

  async setCachedPartial(partial: unknown): Promise<void> {
    const cur = await this.getCached()
    const p =
      partial !== undefined && typeof partial === 'object' && !Array.isArray(partial)
        ? (partial as Record<string, unknown>)
        : {}
    const next = { ...cur, ...p }
    await this.setCached(next)
  }
}

export function createUnifiedPrismarineCacheFactory(
  cacheJsonPath: string,
  username: string,
  forceRefresh: boolean
): CacheFactory {
  const hash = prismarineUserHash(username)
  return ({ cacheName, username: u }: { cacheName: string; username: string }) => {
    if (u !== username) {
      throw new Error(`Unified cache: unexpected username ${u} (expected ${username})`)
    }
    const c = new UnifiedAuthFileCache(cacheJsonPath, `${hash}_${cacheName}`)
    if (forceRefresh) {
      void c.reset()
    }
    return c
  }
}

/** Wenn noch keine {@code auth.json} existiert: alte {@code <hash>_live-cache.json} usw. übernehmen. */
export function migrateLegacyPrismarineCaches(cacheDir: string, authJsonPath: string, log: Logger): void {
  if (fs.existsSync(authJsonPath)) return
  const merged: Record<string, unknown> = {}
  let n = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const match = ent.name.match(LEGACY_CACHE_RE)
    if (!match) continue
    const key = `${match[1]}_${match[2].toLowerCase()}`
    try {
      const body = fs.readFileSync(path.join(cacheDir, ent.name), 'utf8')
      merged[key] = JSON.parse(body) as unknown
      n++
    } catch {
      log.warn(`Auth: Legacy-Cache übersprungen (kaputt): ${ent.name}`)
    }
  }
  if (n === 0) return
  fs.mkdirSync(path.dirname(authJsonPath), { recursive: true })
  fs.writeFileSync(authJsonPath, JSON.stringify(merged, null, 2), 'utf8')
  log.info(
    `Auth: ${n} Legacy-Datei(en) nach ${authJsonPath} migriert — du kannst die alten *-cache.json in ${cacheDir} löschen`
  )
}
