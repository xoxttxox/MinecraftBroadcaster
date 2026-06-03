import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

export type PlayerHistoryStore = {
  isFirstRun(): boolean

  /**
   * Xbox Social-/Friend-Liste:
   * Wird bei Friend-Sync aktualisiert und ist die Basis für Expiry.
   */
  touchSocialLastSeen(xuid: string, gamertag: string, iso?: string): void

  /**
   * Xbox-Session-Join:
   * Wird aufgerufen, sobald ein neuer Remote-XUID in der Xbox Session Directory auftaucht.
   * Hinweis: Das ist ein Xbox-Session-Join/Join-Versuch, nicht zwingend ein garantiert abgeschlossener Bedrock-Server-Login.
   */
  touchPlayerJoin(xuid: string, gamertag: string, iso?: string): void

  /**
   * Session-Invite wurde erfolgreich versendet.
   */
  touchInviteSent(xuid: string, gamertag: string, iso?: string): void

  /**
   * Friend-Request wurde angenommen.
   */
  touchFriendRequestAccepted(xuid: string, gamertag: string, iso?: string): void

  /**
   * Gibt XUID -> last_social_seen_at zurück. Wird vom Friend-Expiry benutzt.
   */
  all(): Record<string, string>

  /**
   * Entfernt einen Spieler komplett aus der History.
   */
  clear(xuid: string): void
}

/**
 * SQLite unter PLAYER_HISTORY_DB.
 *
 * Zweck:
 * - Friend-Sync / Expiry über first_social_seen_at + last_social_seen_at
 * - Xbox-Session-Join-History über first_join_at + last_join_at + join_count
 * - Invite-/Friend-Request-Zeitpunkte für Debug/Admin-Übersicht
 *
 * Diese Klasse migriert alte Layouts automatisch:
 * - Legacy last_seen -> first_social_seen_at / last_social_seen_at
 * - altes first_seen_at / last_seen_at -> social-Spalten
 * - alte join_count-Spalte wird übernommen, wenn vorhanden
 * - last_welcome_sent_at wird bewusst entfernt
 */
export class PlayerHistoryDb implements PlayerHistoryStore {
  private readonly db: Database.Database
  private readonly firstRun: boolean

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath)
    fs.mkdirSync(dir, { recursive: true })

    const legacyJson = path.join(dir, 'player_history_ts.json')

    this.firstRun = !fs.existsSync(dbPath)
    this.db = new Database(dbPath)

    this.normalizeSchema()

    if (this.firstRun && fs.existsSync(legacyJson)) {
      this.importLegacyJson(legacyJson)
    }
  }

  isFirstRun(): boolean {
    return this.firstRun
  }

  /**
   * Erstellt oder migriert die Tabelle auf das aktuelle Layout.
   */
  private normalizeSchema(): void {
    const exists = this.db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'player_history'
        `
      )
      .get()

    if (!exists) {
      this.createSchema()
      return
    }

    const cols = this.db.prepare('PRAGMA table_info(player_history)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))

    const expected = [
      'xuid',
      'gamertag',
      'first_social_seen_at',
      'last_social_seen_at',
      'first_join_at',
      'last_join_at',
      'join_count',
      'last_invite_sent_at',
      'invite_count',
      'last_friend_request_accepted_at',
      'friend_request_accept_count',
      'created_at',
      'updated_at'
    ]

    const isClean = cols.length === expected.length && expected.every((name) => names.has(name))
    if (isClean) return

    const rows = this.db.prepare('SELECT * FROM player_history').all() as Record<string, unknown>[]

    const migrate = this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS player_history__new;
        ${this.schemaSql('player_history__new')}
      `)

      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO player_history__new (
          xuid,
          gamertag,
          first_social_seen_at,
          last_social_seen_at,
          first_join_at,
          last_join_at,
          join_count,
          last_invite_sent_at,
          invite_count,
          last_friend_request_accepted_at,
          friend_request_accept_count,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const now = new Date().toISOString()

      for (const row of rows) {
        const xuid = this.cleanString(row.xuid)
        if (!xuid) continue

        const gamertag =
          this.cleanString(row.gamertag) ??
          this.cleanString(row.displayName) ??
          ''

        const lastSocialSeen =
          this.cleanString(row.last_social_seen_at) ??
          this.cleanString(row.last_seen_at) ??
          this.cleanString(row.last_seen) ??
          undefined

        const firstSocialSeen =
          this.cleanString(row.first_social_seen_at) ??
          this.cleanString(row.first_seen_at) ??
          this.cleanString(row.first_seen) ??
          lastSocialSeen

        const firstJoin =
          this.cleanString(row.first_join_at) ??
          undefined

        const lastJoin =
          this.cleanString(row.last_join_at) ??
          undefined

        const joinCount = this.cleanInteger(row.join_count, 0)
        const lastInviteSent = this.cleanString(row.last_invite_sent_at) ?? undefined
        const inviteCount = this.cleanInteger(row.invite_count, 0)
        const lastFriendRequestAccepted = this.cleanString(row.last_friend_request_accepted_at) ?? undefined
        const friendRequestAcceptCount = this.cleanInteger(row.friend_request_accept_count, 0)
        const createdAt = this.cleanString(row.created_at) ?? firstSocialSeen ?? firstJoin ?? now
        const updatedAt = this.cleanString(row.updated_at) ?? lastSocialSeen ?? lastJoin ?? createdAt

        insert.run(
          xuid,
          gamertag,
          firstSocialSeen ?? null,
          lastSocialSeen ?? null,
          firstJoin ?? null,
          lastJoin ?? null,
          joinCount,
          lastInviteSent ?? null,
          inviteCount,
          lastFriendRequestAccepted ?? null,
          friendRequestAcceptCount,
          createdAt,
          updatedAt
        )
      }

      this.db.exec(`
        DROP TABLE player_history;
        ALTER TABLE player_history__new RENAME TO player_history;
      `)
    })

    migrate()
  }

  private createSchema(): void {
    this.db.exec(this.schemaSql('player_history'))
  }

  private schemaSql(tableName: string): string {
    return `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        xuid TEXT PRIMARY KEY NOT NULL,
        gamertag TEXT NOT NULL DEFAULT '',

        first_social_seen_at TEXT,
        last_social_seen_at TEXT,

        first_join_at TEXT,
        last_join_at TEXT,
        join_count INTEGER NOT NULL DEFAULT 0,

        last_invite_sent_at TEXT,
        invite_count INTEGER NOT NULL DEFAULT 0,

        last_friend_request_accepted_at TEXT,
        friend_request_accept_count INTEGER NOT NULL DEFAULT 0,

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
  }

  private importLegacyJson(legacyJson: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(legacyJson, 'utf8')) as Record<string, string>
      const now = new Date().toISOString()

      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO player_history (
          xuid,
          gamertag,
          first_social_seen_at,
          last_social_seen_at,
          first_join_at,
          last_join_at,
          join_count,
          last_invite_sent_at,
          invite_count,
          last_friend_request_accepted_at,
          friend_request_accept_count,
          created_at,
          updated_at
        )
        VALUES (?, '', ?, ?, NULL, NULL, 0, NULL, 0, NULL, 0, ?, ?)
      `)

      for (const [xuid, iso] of Object.entries(raw)) {
        if (typeof iso !== 'string') continue

        const id = this.cleanString(xuid)
        const seenAt = this.cleanString(iso)
        if (!id || !seenAt) continue

        insert.run(id, seenAt, seenAt, now, now)
      }
    } catch {
      // Ignore broken legacy file.
    }
  }

  private cleanString(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined

    const trimmed = String(value).trim()
    if (!trimmed) return undefined

    return trimmed
  }

  private cleanInteger(value: unknown, fallback: number): number {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 0) return fallback
    return number
  }

  private normalizedNow(iso?: string): string {
    return this.cleanString(iso) ?? new Date().toISOString()
  }

  private normalizedIdentity(xuid: string, gamertag: string): { xuid: string; gamertag: string } | undefined {
    const id = this.cleanString(xuid)
    if (!id) return undefined

    return {
      xuid: id,
      gamertag: this.cleanString(gamertag) ?? ''
    }
  }

  /**
   * Upsert-Grundlage für alle Event-Funktionen.
   * Erstellt fehlende Spielerzeile, ohne Event-spezifische Werte zu verändern.
   */
  private ensurePlayerRow(xuid: string, gamertag: string, iso?: string): { xuid: string; gamertag: string; now: string } | undefined {
    const identity = this.normalizedIdentity(xuid, gamertag)
    if (!identity) return undefined

    const now = this.normalizedNow(iso)

    this.db
      .prepare(
        `
        INSERT INTO player_history (
          xuid,
          gamertag,
          first_social_seen_at,
          last_social_seen_at,
          first_join_at,
          last_join_at,
          join_count,
          last_invite_sent_at,
          invite_count,
          last_friend_request_accepted_at,
          friend_request_accept_count,
          created_at,
          updated_at
        )
        VALUES (?, ?, NULL, NULL, NULL, NULL, 0, NULL, 0, NULL, 0, ?, ?)
        ON CONFLICT(xuid) DO UPDATE SET
          gamertag = CASE
            WHEN excluded.gamertag != '' THEN excluded.gamertag
            ELSE player_history.gamertag
          END,
          updated_at = excluded.updated_at
        `
      )
      .run(identity.xuid, identity.gamertag, now, now)

    return { ...identity, now }
  }

  touchSocialLastSeen(xuid: string, gamertag: string, iso?: string): void {
    const row = this.ensurePlayerRow(xuid, gamertag, iso)
    if (!row) return

    this.db
      .prepare(
        `
        UPDATE player_history
        SET
          gamertag = CASE
            WHEN ? != '' THEN ?
            ELSE gamertag
          END,
          first_social_seen_at = CASE
            WHEN first_social_seen_at IS NULL OR first_social_seen_at = '' THEN ?
            ELSE first_social_seen_at
          END,
          last_social_seen_at = ?,
          updated_at = ?
        WHERE xuid = ?
        `
      )
      .run(row.gamertag, row.gamertag, row.now, row.now, row.now, row.xuid)
  }

  touchPlayerJoin(xuid: string, gamertag: string, iso?: string): void {
    const row = this.ensurePlayerRow(xuid, gamertag, iso)
    if (!row) return

    this.db
      .prepare(
        `
        UPDATE player_history
        SET
          gamertag = CASE
            WHEN ? != '' THEN ?
            ELSE gamertag
          END,
          first_join_at = CASE
            WHEN first_join_at IS NULL OR first_join_at = '' THEN ?
            ELSE first_join_at
          END,
          last_join_at = ?,
          join_count = join_count + 1,
          updated_at = ?
        WHERE xuid = ?
        `
      )
      .run(row.gamertag, row.gamertag, row.now, row.now, row.now, row.xuid)
  }

  touchInviteSent(xuid: string, gamertag: string, iso?: string): void {
    const row = this.ensurePlayerRow(xuid, gamertag, iso)
    if (!row) return

    this.db
      .prepare(
        `
        UPDATE player_history
        SET
          gamertag = CASE
            WHEN ? != '' THEN ?
            ELSE gamertag
          END,
          last_invite_sent_at = ?,
          invite_count = invite_count + 1,
          updated_at = ?
        WHERE xuid = ?
        `
      )
      .run(row.gamertag, row.gamertag, row.now, row.now, row.xuid)
  }

  touchFriendRequestAccepted(xuid: string, gamertag: string, iso?: string): void {
    const row = this.ensurePlayerRow(xuid, gamertag, iso)
    if (!row) return

    this.db
      .prepare(
        `
        UPDATE player_history
        SET
          gamertag = CASE
            WHEN ? != '' THEN ?
            ELSE gamertag
          END,
          last_friend_request_accepted_at = ?,
          friend_request_accept_count = friend_request_accept_count + 1,
          updated_at = ?
        WHERE xuid = ?
        `
      )
      .run(row.gamertag, row.gamertag, row.now, row.now, row.xuid)
  }

  all(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT xuid, last_social_seen_at FROM player_history WHERE last_social_seen_at IS NOT NULL')
      .all() as {
      xuid: string
      last_social_seen_at: string
    }[]

    const result: Record<string, string> = {}

    for (const row of rows) {
      result[row.xuid] = row.last_social_seen_at
    }

    return result
  }

  clear(xuid: string): void {
    const id = this.cleanString(xuid)
    if (!id) return

    this.db.prepare('DELETE FROM player_history WHERE xuid = ?').run(id)
  }
}
