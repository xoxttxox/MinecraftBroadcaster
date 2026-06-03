import type { IceServer } from 'node-datachannel'
import { Server, type SignalStructure } from 'nethernet'
import type { Logger } from '../core/logger'
import { attachBedrockRedirect, type BedrockRedirectTarget } from './bedrockRedirect'
import { attachPeerConnectionDiagnostics } from './webrtcDiagnostics'

export type { BedrockRedirectTarget, NetherNetRelayTarget } from './bedrockRedirect'

/**
 * Host-side NetherNet {@link Server} with minimal Bedrock redirect (handshake → transfer only).
 * No long-lived UDP/RakNet proxy — the client connects directly to Geyser/Bedrock after transfer.
 */
export function createNetherNetHost(options: {
  networkId: bigint
  log: Logger
  getRelay: () => BedrockRedirectTarget
}): Server {
  const server = new Server({ networkId: options.networkId })

  const origHandleOffer = server.handleOffer.bind(server)
  server.handleOffer = async (
    signal: SignalStructure,
    respond: (s: SignalStructure) => void,
    credentials?: (string | IceServer)[]
  ): Promise<void> => {
    await origHandleOffer(signal, respond, credentials)
    const c = server.connections.get(signal.connectionId)
    if (c) {
      attachPeerConnectionDiagnostics(c, options.log, signal.connectionId.toString())
    }
  }

  attachBedrockRedirect(server, options.log, options.getRelay)
  return server
}
