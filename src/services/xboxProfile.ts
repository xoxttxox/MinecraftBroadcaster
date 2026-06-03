import type { Logger } from '../core/logger'

const PROFILE_BATCH_SETTINGS = 'https://profile.xboxlive.com/users/batch/profile/settings'

/**
 * Löst Gamertag aus XUID per Xbox Profile v2 (gleiches Auth wie PeopleHub).
 * Fallback: {@code xuid} (nie literales „Unknown“).
 */
export async function fetchGamertagForXuid(
  getXblAuth: () => Promise<string>,
  xuid: string,
  log: Logger
): Promise<string> {
  try {
    const auth = await getXblAuth()
    const res = await fetch(PROFILE_BATCH_SETTINGS, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        /** v3 liefert bei manchen Konten ModernGamertag zuverlässiger als v2. */
        'x-xbl-contract-version': '3'
      },
      body: JSON.stringify({
        userIds: [xuid],
        settings: ['Gamertag', 'ModernGamertag', 'UniqueModernGamertag', 'AppDisplayName', 'GameDisplayName']
      })
    })
    if (!res.ok) {
      log.debug(`Profile batch for XUID ${xuid}: HTTP ${res.status}`)
      return xuid
    }
    const j = (await res.json()) as {
      profileUsers?: Array<{ id?: string; settings?: Array<{ id?: string; value?: string }> }>
    }
    const settings = j.profileUsers?.[0]?.settings ?? []
    for (const key of [
      'ModernGamertag',
      'Gamertag',
      'UniqueModernGamertag',
      'AppDisplayName',
      'GameDisplayName'
    ]) {
      const v = settings.find((s) => s.id === key)?.value?.trim()
      if (v) return v
    }
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e)
    log.debug(`Gamertag lookup failed for ${xuid}: ${hint}`)
  }
  return xuid
}
