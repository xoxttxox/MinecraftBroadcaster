import { generateKeyPairSync, KeyObject } from 'crypto'
import { Authflow, Titles } from 'prismarine-auth'
import type { AuthDeviceProfile } from '../config/config'
import { AUTH_CACHE_FILE } from '../core/paths'
import type { Logger } from '../core/logger'
import { createUnifiedPrismarineCacheFactory } from '../storage/unifiedPrismarineCache'

export type XboxToken = {
  userXUID: string
  userHash: string
  XSTSToken: string
  expiresOn: number
}

export function xblAuthorization(x: XboxToken): string {
  return `XBL3.0 x=${x.userHash};${x.XSTSToken}`
}

function decodeJwtPayload(part: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    try {
      const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4))
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + pad
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}

/** PlayFab / MCS JWT may expose the profile message id under several keys (Java: {@code reqString("pmid")}). */
function pmidFromMcToken(mcToken: string): string | undefined {
  try {
    const jwt = mcToken.replace(/^MCToken\s+/i, '').replace(/^Bearer\s+/i, '').trim()
    const parts = jwt.split('.')
    if (parts.length < 2) return undefined
    const payload = decodeJwtPayload(parts[1])
    if (!payload) return undefined
    const candidates = ['pmid', 'pmsgId', 'PmsgId', 'playMessageId', 'PlayMessageId', 'profileMessageId']
    for (const k of candidates) {
      const v = payload[k]
      if (typeof v === 'string' && v.length > 0) return v
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Bedrock EC key pair for prismarine-auth (cached per process) */
let cachedKey: KeyObject | null = null

function bedrockPrivateKey(): KeyObject {
  if (cachedKey) return cachedKey
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' })
  cachedKey = privateKey
  return cachedKey
}

function titleAndDeviceForProfile(profile: AuthDeviceProfile): { authTitle: Titles; deviceType: string } {
  switch (profile) {
    case 'android':
      return { authTitle: Titles.MinecraftAndroid, deviceType: 'Android' }
    case 'ios':
      return { authTitle: Titles.MinecraftIOS, deviceType: 'iOS' }
    case 'playstation':
      return { authTitle: Titles.MinecraftPlaystation, deviceType: 'PlayStation' }
    case 'windows':
      /**
       * Kein {@code MinecraftWindows} in prismarine-auth. {@code MinecraftAndroid} + {@code Win32} liefert bei
       * {@code getTitleToken} zuverlässig **400 Bad Request** — Microsoft erwartet passende Paare (Android+Android, …).
       * Alias: gleiches Login wie Android (Anzeige in Xbox eher „Mobile“, nicht Windows-GDK).
       */
      return { authTitle: Titles.MinecraftAndroid, deviceType: 'Android' }
    case 'nintendo':
      return { authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' }
  }
}

export class BedrockAuthService {
  private flow: InstanceType<typeof Authflow> | null = null

  constructor(
    private readonly log: Logger,
    private readonly bedrockVersion: string,
    private readonly deviceProfile: AuthDeviceProfile,
    /** {@code live} nutzt getTitleToken; {@code sisu} oft nötig für Android/iOS (sonst 400 auf Title-Auth). */
    private readonly prismarineFlow: 'live' | 'sisu',
    private readonly onDeviceCode: (uri: string, code: string) => void
  ) {}

  private async getFlow(): Promise<InstanceType<typeof Authflow>> {
    if (this.flow) return this.flow
    const { authTitle, deviceType } = titleAndDeviceForProfile(this.deviceProfile)
    /* Separate cache namespace per profile so switching auth.deviceProfile does not mix tokens */
    const cacheUser = `mcxboxbroadcast-${this.deviceProfile}`
    this.flow = new Authflow(
      cacheUser,
      createUnifiedPrismarineCacheFactory(AUTH_CACHE_FILE, cacheUser, false),
      {
        authTitle,
        deviceType,
        flow: this.prismarineFlow
      },
      (res: { user_code: string; verification_uri: string }) => {
        this.onDeviceCode(res.verification_uri, res.user_code)
      }
    )
    return this.flow
  }

  getDeviceProfile(): AuthDeviceProfile {
    return this.deviceProfile
  }

  async getXboxToken(): Promise<XboxToken> {
    const flow = await this.getFlow()
    return flow.getXboxToken('http://xboxlive.com')
  }

  async getMcTokenAndPmid(): Promise<{ mcToken: string; pmid?: string }> {
    const flow = await this.getFlow()
    const { mcToken } = await flow.getMinecraftBedrockServicesToken({ version: this.bedrockVersion })
    const pmid = pmidFromMcToken(mcToken)
    if (!pmid) this.log.warn('Could not read pmid from MCToken JWT; session join metadata may be incomplete')
    return { mcToken, pmid }
  }

  /** PlayFab session ticket path used internally by MCS token; exposed for debugging */
  async refreshChainInfo(): Promise<void> {
    const flow = await this.getFlow()
    const key = bedrockPrivateKey()
    await flow.getMinecraftBedrockToken(key, { version: this.bedrockVersion })
  }
}
