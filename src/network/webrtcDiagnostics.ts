import type { Connection } from 'nethernet'
import type { Logger } from '../core/logger'

/**
 * Subscribe to node-datachannel {@link PeerConnection} callbacks right after nethernet {@code handleOffer}
 * (before ICE completes — otherwise you never see {@code checking}/{@code failed}).
 */
export function attachPeerConnectionDiagnostics(
  connection: Connection,
  log: Logger,
  connectionIdLabel: string
): void {
  const pc = connection.rtcConnection

  pc.onIceStateChange((state: string) => {
    log.info(`[WebRTC] ice state=${state}`)
    try {
      const pair = pc.getSelectedCandidatePair()
      if (pair) {
        log.debug(
          `[WebRTC] selected candidate pair connectionId=${connectionIdLabel} local=${pair.local?.type ?? '?'}/${pair.local?.address ?? '?'} remote=${pair.remote?.type ?? '?'}/${pair.remote?.address ?? '?'}`
        )
      }
    } catch {
      /* ignore */
    }
  })

  pc.onGatheringStateChange((state: string) => {
    log.debug(`[WebRTC] gathering state=${state}`)
  })

  pc.onStateChange((state: string) => {
    log.info(`[WebRTC] connection state=${state}`)
  })

  pc.onSignalingStateChange((state: string) => {
    log.debug(`[WebRTC] signaling state=${state}`)
  })

  /** Reliable / unreliable channels appear asynchronously after SDP — poll briefly for label/state. */
  let n = 0
  const iv = setInterval(() => {
    n++
    const rel = connection.reliable
    const unr = connection.unreliable
    const rs = rel ? String((rel as { readyState?: string }).readyState ?? 'open') : 'none'
    const us = unr ? String((unr as { readyState?: string }).readyState ?? 'open') : 'none'
    if (rel || unr || n >= 80) {
      log.debug(
        `[WebRTC] data channel state reliable=${rs} unreliable=${us} connectionId=${connectionIdLabel}`
      )
      if (rel || unr || n >= 80) clearInterval(iv)
    }
  }, 250)
}
