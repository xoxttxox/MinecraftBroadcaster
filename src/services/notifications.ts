import type { CoreConfigYaml, NotificationsYaml } from '../config/config'
import type { Logger } from '../core/logger'
import type { RtaSocialGraphEvent } from '../network/rtaSession'
import type { DiscordEmbed } from './discordWebhook'
import {
  EMBED_COLORS,
  discordPayloadNeedsEveryoneParse,
  isDiscordWebhookUrl,
  normalizeDiscordWebhookExecuteUrl,
  normalizeSlackToDiscordMentions,
  splitLeadingDiscordMentions,
  truncateDiscordDescription
} from './discordWebhook'
import { fetchGamertagForXuid } from './xboxProfile'

/** Gleiche Discord-Zeile wie {@link notifyFriendRemoved}, aber mit Abstand — verhindert Doppelpost (RTA + Poll, mehrere RTA). */
const remoteRemovalDiscordAt = new Map<string, number>()
const REMOTE_REMOVAL_DEDUPE_MS = 120_000

function shouldSkipRemoteRemovalDiscord(xuid: string): boolean {
  const t = remoteRemovalDiscordAt.get(xuid)
  return t !== undefined && Date.now() - t < REMOTE_REMOVAL_DEDUPE_MS
}

function recordRemoteRemovalDiscord(xuid: string): void {
  remoteRemovalDiscordAt.set(xuid, Date.now())
}

async function postNotification(
  n: NotificationsYaml,
  log: Logger,
  label: string,
  plainText: string,
  embedTitle: string,
  color: number
): Promise<void> {
  const urlRaw = n.webhookUrl!
  const execUrl = normalizeDiscordWebhookExecuteUrl(urlRaw)
  const useEmbed = n.discordEmbeds !== false && isDiscordWebhookUrl(urlRaw)

  try {
    const normalizedText = normalizeSlackToDiscordMentions(plainText)
    if (useEmbed) {
      const { content, rest } = splitLeadingDiscordMentions(normalizedText)
      const description = truncateDiscordDescription(rest.length > 0 ? rest : normalizedText)
      const embed: DiscordEmbed = {
        title: embedTitle.slice(0, 256),
        description,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: (n.embedFooterText ?? 'MCXboxBroadcast').slice(0, 2048) }
      }
      const body: Record<string, unknown> = {
        username: (n.discordWebhookUsername ?? 'MCXboxBroadcast').slice(0, 80),
        embeds: [embed]
      }
      if (content) body.content = content.slice(0, 2000)
      const forEveryoneCheck = `${content}\n${description}`
      if (discordPayloadNeedsEveryoneParse(forEveryoneCheck)) {
        body.allowed_mentions = { parse: ['everyone'] }
      }

      await fetch(execUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } else {
      const discordPlain = isDiscordWebhookUrl(urlRaw)
      const payload: Record<string, unknown> = discordPlain
        ? { content: normalizedText.slice(0, 2000) }
        : { text: normalizedText }
      if (discordPlain && discordPayloadNeedsEveryoneParse(normalizedText)) {
        payload.allowed_mentions = { parse: ['everyone'] }
      }
      await fetch(execUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    }
  } catch (e) {
    log.error(`Failed to send ${label} notification`, e)
  }
}

/** Replace first two %s in order (gamertag, xuid). */
function formatTwoPlaceholders(template: string, a: string, b: string): string {
  return template.replace('%s', a).replace('%s', b)
}

export async function notifySessionExpired(
  cfg: CoreConfigYaml,
  log: Logger,
  uri: string,
  code: string
): Promise<void> {
  const n = cfg.notifications
  if (!n?.enabled || !n.webhookUrl) return
  let text = n.sessionExpiredMessage ?? ''
  text = text.replace('%s', uri)
  text = text.replace('%s', code)
  await postNotification(n, log, 'session-expired', text, 'Session expired', EMBED_COLORS.sessionExpired)
}

export async function notifyFriendAdded(
  n: CoreConfigYaml['notifications'],
  log: Logger,
  gamertag: string,
  xuid: string
): Promise<void> {
  if (!n?.enabled || !n.webhookUrl) return
  const text = formatTwoPlaceholders(n.friendAddedMessage ?? '%s (%s) was added as a friend.', gamertag, xuid)
  await postNotification(n, log, 'friend-added', text, 'Friend added', EMBED_COLORS.friendAdded)
}

/** Wenn **dieses** Programm per API einen Freund entfernt (DELETE) — kein Remote-Dedupe. */
export async function notifyFriendRemoved(
  n: CoreConfigYaml['notifications'],
  log: Logger,
  gamertag: string,
  xuid: string
): Promise<void> {
  if (!n?.enabled || !n.webhookUrl) return
  const text = formatTwoPlaceholders(n.friendRemovedMessage ?? '%s (%s) was removed from friends.', gamertag, xuid)
  await postNotification(n, log, 'friend-removed', text, 'Friend removed', EMBED_COLORS.friendRemoved)
}

/**
 * Wenn die **andere Seite** die Beziehung beendet oder aus der Merge-Liste fällt — nutzt dieselbe Vorlage wie {@link notifyFriendRemoved}.
 */
export async function notifyFriendRemovedRemote(
  n: CoreConfigYaml['notifications'] | undefined,
  log: Logger,
  gamertag: string,
  xuid: string
): Promise<void> {
  if (!n?.enabled || !n.webhookUrl) return
  if (shouldSkipRemoteRemovalDiscord(xuid)) return
  await notifyFriendRemoved(n, log, gamertag, xuid)
  recordRemoteRemovalDiscord(xuid)
}

export async function notifyFriendRequestAccepted(
  n: CoreConfigYaml['notifications'],
  log: Logger,
  gamertag: string,
  xuid: string
): Promise<void> {
  if (!n?.enabled || !n.webhookUrl) return
  const text = formatTwoPlaceholders(
    n.friendRequestAcceptedMessage ?? 'Accepted friend request from %s (%s).',
    gamertag,
    xuid
  )
  await postNotification(n, log, 'friend-request-accepted', text, 'Friend request accepted', EMBED_COLORS.friendRequest)
}

export async function notifyFriendExpiryRemoval(
  n: CoreConfigYaml['notifications'],
  log: Logger,
  xuid: string
): Promise<void> {
  if (!n?.enabled || !n.webhookUrl) return
  const tpl = n.friendExpiryRemovalMessage ?? '%s was removed from friends (inactive / expiry).'
  const text = tpl.replace('%s', xuid)
  await postNotification(n, log, 'friend-expiry-removal', text, 'Friend removed (inactive)', EMBED_COLORS.friendExpiry)
}

/**
 * RTA Friends-Feed: nur **Removed** → {@link friendRemovedMessage} ({@link notifyFriendRemovedRemote}).
 * Gamertag per Profile-API; **Added** kein Webhook (PUT/accept liefern schon {@link notifyFriendAdded}).
 */
export async function notifyRtaSocialEvent(
  n: CoreConfigYaml['notifications'] | undefined,
  log: Logger,
  ev: RtaSocialGraphEvent,
  getXblAuth: () => Promise<string>
): Promise<void> {
  if (!n?.enabled || !n.webhookUrl) return
  if (ev.notificationType.toLowerCase() === 'removed') {
    const removed = ev.removedRelationships.map((r) => r.toLowerCase())
    const onlyFollows =
      removed.length > 0 && removed.every((r) => r === 'follows' || r === 'follow')
    if (onlyFollows) return
    const looksLikeUnfriend =
      removed.length === 0 ||
      removed.some((r) => r === 'friend' || r === 'legacyfriend' || r === 'legacy_friend')
    if (!looksLikeUnfriend) return

    const tag = await fetchGamertagForXuid(getXblAuth, ev.xuid, log)
    await notifyFriendRemovedRemote(n, log, tag, ev.xuid)
  }
}
