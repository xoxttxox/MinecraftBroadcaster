import {
  CONNECTION_TYPE_JSON_RPC,
  CONNECTION_TYPE_WEBRTC_SIGNALING,
  SERVICE_CONFIG_ID,
  TEMPLATE_NAME,
  TITLE_ID
} from '../core/constants'
import type { ExpandedSessionInfo } from './expandedSessionInfo'

/**
 * Session directory JSON aligned with Java {@code CreateSessionRequest}, plus a second {@code SupportedConnections}
 * row for {@code CONNECTION_TYPE_WEBRTC_SIGNALING} — nethernet-spec / Xbox P2P docs use {@code WebRTCNetworkId}
 * for many Bedrock clients (Android, iOS, Switch) while JsonRpc ({@code NetherNetId}+{@code PmsgId}) matches Java/Windows.
 * Optional {@link ExpandedSessionInfo.onlyWebRtcSignalingConnection}: nur Typ 3 (Test).
 */
export function buildCreateSessionRequest(
  session: ExpandedSessionInfo,
  nonces: Record<string, string>
): object {
  const netherNetNum = session.netherNetIdJsonNumber()
  const supportedConnectionsOnlyWebRtc = session.onlyWebRtcSignalingConnection
    ? [
        {
          ConnectionType: CONNECTION_TYPE_WEBRTC_SIGNALING,
          HostIpAddress: '',
          HostPort: 0,
          WebRTCNetworkId: netherNetNum
        }
      ]
    : null
  return {
    members: {
      me: {
        constants: {
          system: {
            xuid: session.xuid,
            initialize: true
          }
        },
        properties: {
          system: {
            active: true,
            connection: session.connectionId,
            subscription: {
              id: session.subscriptionId,
              changeTypes: ['everything']
            }
          }
        }
      }
    },
    properties: {
      system: {
        /**
         * Xbox lehnt {@code none} für diese Vorlage ab ({@code userAuthorizationStyle}):
         * „cannot be set to none on sessions with the 'userAuthorizationStyle' capability.“
         */
        joinRestriction: 'followed',
        readRestriction: 'followed',
        closed: false
      },
      custom: {
        BroadcastSetting: session.getBroadcastSetting(),
        CrossPlayDisabled: false,
        Joinability: 'joinable_by_friends',
        LanGame: false,
        MaxMemberCount: session.getMaxPlayers(),
        MemberCount: session.getPlayers(),
        OnlineCrossPlatformGame: true,
        SupportedConnections:
          supportedConnectionsOnlyWebRtc ??
          (() => {
            const primary = {
              ConnectionType: CONNECTION_TYPE_JSON_RPC,
              HostIpAddress: '',
              HostPort: 0,
              NetherNetId: netherNetNum,
              PmsgId: session.pmsgId || session.xuid
            }
            if (!session.extraWebRtcSignalingConnection) {
              return [primary]
            }
            return [
              primary,
              {
                ConnectionType: CONNECTION_TYPE_WEBRTC_SIGNALING,
                HostIpAddress: '',
                HostPort: 0,
                WebRTCNetworkId: netherNetNum
              }
            ]
          })(),
        TitleId: Number(TITLE_ID),
        TransportLayer: session.getTransportLayer(),
        levelId: 'level',
        hostName: session.getHostName(),
        ownerId: session.xuid,
        rakNetGUID: session.rakNetGuid,
        worldName: session.getWorldName(),
        worldType: session.getWorldType(),
        protocol: session.getProtocol(),
        version: session.getVersion(),
        isEditorWorld: false,
        isHardcore: false,
        nonces
      }
    }
  }
}

/** Activity handle (joinable session) — only these fields; no invitedXuid (that is for type "invite"). */
export function buildCreateHandleRequest(sessionId: string): object {
  return {
    version: 1,
    type: 'activity',
    sessionRef: {
      scid: SERVICE_CONFIG_ID,
      templateName: TEMPLATE_NAME,
      name: sessionId
    }
  }
}
