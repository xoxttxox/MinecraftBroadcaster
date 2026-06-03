/** Xbox Live / session directory (aligned with Java {@code Constants}) */
export const SERVICE_CONFIG_ID = '4fc10100-5f7a-4470-899b-280835760c07'
export const TEMPLATE_NAME = 'MinecraftLobby'
/** Test: wie Session-GET {@code activeTitleId} (Xbox-Minecraft); Standard Windows-Bedrock war 896928775. */
export const TITLE_ID = '896928775'

export const CREATE_SESSION = (sessionId: string) =>
  `https://sessiondirectory.xboxlive.com/serviceconfigs/${SERVICE_CONFIG_ID}/sessionTemplates/${TEMPLATE_NAME}/sessions/${sessionId}`

export const JOIN_SESSION = (handle: string) =>
  `https://sessiondirectory.xboxlive.com/handles/${handle}/session`

export const RTA_WEBSOCKET = 'wss://rta.xboxlive.com/connect'
export const CREATE_HANDLE = 'https://sessiondirectory.xboxlive.com/handles'

export const PEOPLE = (xuid: string) =>
  `https://social.xboxlive.com/users/me/people/xuid(${xuid})`

export const USER_PRESENCE = (xuid: string) =>
  `https://userpresence.xboxlive.com/users/xuid(${xuid})/devices/current/titles/current`

export const FOLLOWERS = 'https://peoplehub.xboxlive.com/users/me/people/followers'
export const SOCIAL = 'https://peoplehub.xboxlive.com/users/me/people/social'
export const SOCIAL_SUMMARY = 'https://social.xboxlive.com/users/me/summary'
export const FOLLOWER = (xuid: string) =>
  `https://social.xboxlive.com/users/me/people/follower/xuid(${xuid})`

export const GALLERY = 'https://persona.franchise.minecraft-services.net/api/v1.0/gallery'

/** {@code WebSocketsWebRTCJsonRpcSignaling} — Java {@code ConnectionTypeJsonRpc}, MCXboxBroadcast default. */
export const CONNECTION_TYPE_JSON_RPC = 7

/** {@code WebSocketsWebRTCSignaling} — session-directory / nethernet-spec P2P hint many Bedrock clients read this first (Switch, mobile). */
export const CONNECTION_TYPE_WEBRTC_SIGNALING = 3

export const MAX_FRIENDS = 2000

export const WEBSOCKET_CONNECTION_TIMEOUT_MS = 10_000

/** Veraltet: direktes Franchise-Signal pro NetherNetId — aktueller Minecraft-Flow nutzt JsonRPC (siehe unten). */
export const NETHERNET_SIGNALING_BASE =
  'wss://signal.franchise.minecraft-services.net/ws/v1.0/signaling'

/**
 * JsonRPC-Signaling wie {@code NetherNetXboxRpcSignaling} (dev.kastle.netty 1.7+) — nicht {@code …/signaling/&lt;id&gt;}.
 */
export const NETHERNET_JSONRPC_SIGNALING_WS =
  'wss://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect'

/** HTTP-Header wie {@code NetherNetConstants.SIGNALING_USER_AGENT}. */
export const NETHERNET_SIGNALING_USER_AGENT = 'libHttpClient/1.0.0.0'

/** @deprecated Nur Legacy — aktuelles Signaling: {@link NETHERNET_JSONRPC_SIGNALING_WS} (ohne Id im Pfad). */
export function signalingUrl(netherNetId: bigint): string {
  return `${NETHERNET_SIGNALING_BASE}/${netherNetId.toString()}`
}
