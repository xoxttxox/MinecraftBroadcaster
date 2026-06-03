import path from 'path'

export const CACHE_DIR = path.join(process.cwd(), 'cache')
export const LOGS_DIR = path.join(process.cwd(), 'logs')

/** Prismarine/Microsoft Auth tokens only (`<hash>_<cacheName>` namespaces). */
export const AUTH_CACHE_FILE = path.join(CACHE_DIR, 'auth.json')

/** Runtime session metadata (connection ids, last start, …). */
export const SESSIONS_CACHE_FILE = path.join(CACHE_DIR, 'sessions.json')

/** SQLite: friend sync / expiry last-seen (see {@link PlayerHistoryDb}). */
export const PLAYER_HISTORY_DB = path.join(CACHE_DIR, 'player_history.db')

/** Legacy unified file — migrated once to {@link AUTH_CACHE_FILE} / {@link SESSIONS_CACHE_FILE}. */
export const LEGACY_CACHE_JSON = path.join(CACHE_DIR, 'cache.json')
