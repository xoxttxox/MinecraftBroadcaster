import WebSocket from 'ws'
import { RTA_WEBSOCKET, WEBSOCKET_CONNECTION_TIMEOUT_MS } from '../core/constants'
import type { Logger } from '../core/logger'

enum MessageType {
  Subscribe = 1,
  Unsubscribe = 2,
  Event = 3,
  Resync = 4
}

export type RtaSocialGraphEvent = {
  notificationType: string
  xuid: string
  addedRelationships: string[]
  removedRelationships: string[]
}

export type RtaHandlers = {
  onFriendRequestCountChanged?: () => void
  onSessionNetworkChange?: () => void
  /** Triggered when the RTA socket closes unexpectedly. The controller uses this to rotate the full Xbox session immediately. */
  onConnectionLost?: (reason: string) => void
  /** Friends RTA feed: Added/Removed + Follows/Friend (remote changes; not only local API). */
  onSocialGraphEvent?: (ev: RtaSocialGraphEvent) => void
}

/**
 * RTA WebSocket (same behaviour as Java {@code RtaWebsocketClient}).
 */
export class RtaSession {
  private ws: WebSocket | null = null
  private connectionId: string | null = null
  private connectionPromise: Promise<string>
  private resolveConn!: (id: string) => void
  private rejectConn!: (e: Error) => void
  private firstConnection = true
  private readonly requestedClose = new WeakSet<WebSocket>()

  constructor(
    private readonly xblAuth: () => Promise<string>,
    private readonly xuid: string,
    private readonly log: Logger,
    private readonly handlers: RtaHandlers
  ) {
    this.connectionPromise = new Promise((resolve, reject) => {
      this.resolveConn = resolve
      this.rejectConn = reject
    })
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  async waitForConnectionId(): Promise<string> {
    return await Promise.race([
      this.connectionPromise,
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error('RTA connectionId timeout')),
          WEBSOCKET_CONNECTION_TIMEOUT_MS
        )
      )
    ])
  }

  async connect(): Promise<void> {
    const auth = await this.xblAuth()
    if (this.ws) {
      try {
        this.requestedClose.add(this.ws)
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.connectionId = null
    this.firstConnection = true
    this.connectionPromise = new Promise((resolve, reject) => {
      this.resolveConn = resolve
      this.rejectConn = reject
    })

    const ws = new WebSocket(RTA_WEBSOCKET, { headers: { Authorization: auth } })
    this.ws = ws

    ws.on('open', () => {
      ws.send('[1,1,"https://sessiondirectory.xboxlive.com/connections/"]')
    })

    ws.on('message', (data: WebSocket.RawData) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      this.handleMessage(text)
    })

    ws.on('close', (code, reason) => {
      const manualClose = this.requestedClose.has(ws)
      if (this.ws === ws) this.ws = null

      if (this.connectionId === null) {
        this.rejectConn(new Error('RTA disconnected before connectionId'))
      }

      const reasonText = reason.length > 0 ? reason.toString('utf8') : ''
      this.log.debug(`RTA disconnected code=${code}${reasonText ? ` reason=${reasonText}` : ''}${manualClose ? ' manual=true' : ''}`)

      if (!manualClose) {
        this.handlers.onConnectionLost?.(`close:${code}${reasonText ? `:${reasonText}` : ''}`)
      }
    })

    ws.on('error', (err) => {
      this.log.error('RTA WebSocket error', err)
    })
  }

  /**
   * Xbox sendet Added/Removed mit {@code UserData}; manchmal nur {@code Xuids}. Schlüssel können
   * gemischt groß/klein sein.
   */
  private emitSocialGraphEvents(data: Record<string, unknown>): void {
    const rawNt = data.NotificationType
    const ntStr = typeof rawNt === 'string' ? rawNt.trim() : ''
    const ntLower = ntStr.toLowerCase()
    if (ntLower !== 'added' && ntLower !== 'removed') return

    const canonicalNt = ntLower === 'added' ? 'Added' : 'Removed'
    const seen = new Set<string>()
    const rows: Array<{ xuid: string; added: string[]; removed: string[] }> = []

    const userDataRaw = data.UserData
    if (Array.isArray(userDataRaw)) {
      for (const item of userDataRaw) {
        if (!item || typeof item !== 'object') continue
        const u = item as Record<string, unknown>
        const xuid = String(u.Xuid ?? u.xuid ?? '')
        if (!xuid) continue
        seen.add(xuid)
        const added = u.AddedRelationships ?? u.addedRelationships
        const removed = u.RemovedRelationships ?? u.removedRelationships
        rows.push({
          xuid,
          added: Array.isArray(added) ? added.map(String) : [],
          removed: Array.isArray(removed) ? removed.map(String) : []
        })
      }
    }

    const topXuids = data.Xuids
    if (Array.isArray(topXuids)) {
      for (const x of topXuids) {
        const xuid = String(x)
        if (!xuid || seen.has(xuid)) continue
        rows.push({ xuid, added: [], removed: [] })
      }
    }

    for (const row of rows) {
      this.handlers.onSocialGraphEvent?.({
        notificationType: canonicalNt,
        xuid: row.xuid,
        addedRelationships: row.added,
        removedRelationships: row.removed
      })
    }
  }

  private handleMessage(message: string): void {
    let parts: unknown[]
    try {
      parts = JSON.parse(message) as unknown[]
    } catch {
      this.log.debug(`RTA unknown message: ${message}`)
      return
    }
    const typeVal = Number(parts[0])
    const type = typeVal as MessageType

    switch (type) {
      case MessageType.Subscribe: {
        this.log.debug(`RTA subscribed: ${message}`)
        if (this.firstConnection && message.includes('ConnectionId')) {
          const payload = parts[4] as Record<string, string> | undefined
          const cid = payload?.ConnectionId
          if (cid) {
            this.connectionId = cid
            this.firstConnection = false
            this.resolveConn(cid)
            this.ws?.send(`[1,2,"https://social.xboxlive.com/users/xuid(${this.xuid})/friends"]`)
          }
        }
        break
      }
      case MessageType.Unsubscribe:
        this.log.debug(`RTA unsubscribed: ${message}`)
        break
      case MessageType.Event: {
        this.log.debug(`RTA event: ${message}`)
        const data = parts[2] as Record<string, unknown> | undefined
        if (!data) break
        if (data.NotificationType === 'IncomingFriendRequestCountChanged') {
          this.handlers.onFriendRequestCountChanged?.()
        }
        if (Object.prototype.hasOwnProperty.call(data, 'ncid')) {
          this.handlers.onSessionNetworkChange?.()
        }
        this.emitSocialGraphEvents(data)
        break
      }
      case MessageType.Resync:
        this.log.debug(`RTA resync: ${message}`)
        break
      default:
        this.log.debug(`RTA unknown type: ${message}`)
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.requestedClose.add(this.ws)
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }
}
