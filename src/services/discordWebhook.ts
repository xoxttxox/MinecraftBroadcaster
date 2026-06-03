/** Discord Incoming Webhook embed (subset). */
export type DiscordEmbed = {
  title?: string
  description?: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  timestamp?: string
  footer?: { text: string }
}

const WEBHOOK_HOST =
  /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+/i

export function isDiscordWebhookUrl(url: string): boolean {
  const u = url.trim()
  return WEBHOOK_HOST.test(u.replace(/\/slack\/?$/i, ''))
}

/** Slack-kompatible URL → normale Execute-URL (Embeds funktionieren dort). */
export function normalizeDiscordWebhookExecuteUrl(url: string): string {
  return url.trim().replace(/\/slack\/?$/i, '')
}

/**
 * Slack-Incoming-Webhook-Syntax → Discord (Incoming Webhooks verstehen `<!here>` nicht).
 */
export function normalizeSlackToDiscordMentions(text: string): string {
  return text
    .replace(/<!here>/gi, '@here')
    .replace(/<!everyone>/gi, '@everyone')
    .replace(/<!channel>/gi, '@here')
}

/** Mentions von Anfang entfernen → optional `content`, Rest für Embed. */
export function splitLeadingDiscordMentions(text: string): { content: string; rest: string } {
  let s = text.replace(/\r\n/g, '\n')
  const re =
    /^(\s*(?:<@[!&]?\d+>|<@&\d+>|<!here>|<!everyone>|<!channel>|<#\d+>|@here\b|@everyone\b)\s*)+/i
  const m = s.match(re)
  if (!m) return { content: '', rest: s.trim() }
  const content = m[0].trim()
  s = s.slice(m[0].length).trim()
  return { content, rest: s }
}

/** Discord: @here / @everyone nur mit {@code allowed_mentions.parse: ["everyone"]}. */
export function discordPayloadNeedsEveryoneParse(text: string): boolean {
  return /@here\b/i.test(text) || /@everyone\b/i.test(text)
}

export const EMBED_COLORS = {
  friendAdded: 0x57f287,
  friendRemoved: 0xed4245,
  friendRequest: 0x5865f2,
  friendExpiry: 0xfee75c,
  sessionExpired: 0xeb459e,
  generic: 0x99aab5
} as const

export function truncateDiscordDescription(s: string, max = 4090): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}
