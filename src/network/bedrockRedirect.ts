import { comp } from 'prismarine-nbt'
import { inflateRawSync } from 'node:zlib'
import type { Connection, Server } from 'nethernet'
import type { Logger } from '../core/logger'

/** Minecraft Bedrock unsigned VarInt (packet ids, outer frame lengths on WebRTC data channel). */
function readUnsignedVarInt(buf: Buffer, offset = 0): { value: number; offset: number } {
  let value = 0
  let shift = 0
  let pos = offset

  while (pos < buf.length) {
    const b = buf[pos++]!
    value |= (b & 0x7f) << shift

    if ((b & 0x80) === 0) {
      return { value, offset: pos }
    }

    shift += 7
    if (shift > 35) {
      throw new Error('VarInt too long')
    }
  }

  throw new Error('Unexpected end of VarInt')
}

function writeUnsignedVarIntBytes(value: number): Buffer {
  const out: number[] = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return Buffer.from(out)
}

/**
 * Outbound WebRTC Bedrock framing (mirror inbound {@link BedrockRedirect.parseIncomingPayload}).
 * {@code wireCompressionHeader}: {@code false} = nur VarInt+Länge; {@code true} = {@code 0xff}+VarInt+Payload (nach {@code network_settings}).
 */
function frameOutboundBedrockPacket(gamePacket: Buffer, wireCompressionHeader: boolean): Buffer {
  const lenHead = writeUnsignedVarIntBytes(gamePacket.length)
  if (wireCompressionHeader) {
    return Buffer.concat([Buffer.from([0xff]), lenHead, gamePacket])
  }
  return Buffer.concat([lenHead, gamePacket])
}

/** First Bedrock game packet id (unsigned VarInt) for parse-failure diagnostics only. */
function peekBedrockPacketId(buf: Buffer): string {
  if (buf.length === 0) return 'empty'
  try {
    const { value } = readUnsignedVarInt(buf, 0)
    return String(value)
  } catch {
    return 'unreadable'
  }
}

function firstBytesHex(buf: Buffer, max = 16): string {
  return buf.subarray(0, Math.min(max, buf.length)).toString('hex')
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createDeserializer, createSerializer } = require('bedrock-protocol/src/transforms/serializer') as {
  createDeserializer: (version: string) => {
    parsePacketBuffer: (buf: Buffer) => { data: { name: string; params: Record<string, unknown> } }
  }
  createSerializer: (version: string) => {
    createPacketBuffer: (packet: { name: string; params: Record<string, unknown> }) => Buffer
  }
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Framer } = require('bedrock-protocol/src/transforms/framer') as {
  Framer: {
    decode: (client: Record<string, unknown>, buf: Buffer) => Buffer[]
  }
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultOptions: bpDefaultOptions } = require('bedrock-protocol/src/options') as {
  defaultOptions: { compressionLevel: number; compressionThreshold: number }
}

/** Transfer target from {@code config.session.sessionInfo} (real Bedrock/Geyser). */
export interface BedrockRedirectTarget {
  versionName: string
  protocolVersion: number
  host: string
  port: number
}

/** @deprecated Use {@link BedrockRedirectTarget}. */
export type NetherNetRelayTarget = BedrockRedirectTarget

function buildStartGameParams() {
  return {
    entity_id: 1n,
    runtime_entity_id: 1n,
    player_gamemode: 'creative' as const,
    player_position: { x: 0, y: 66, z: 0 },
    rotation: { x: 1, y: 1 },
    seed: 0n,
    biome_type: 0,
    biome_name: '',
    dimension: 'end' as const,
    generator: 1,
    world_gamemode: 'creative' as const,
    hardcore: false,
    difficulty: 0,
    spawn_position: { x: 0, y: 64, z: 0 },
    achievements_disabled: true,
    editor_world_type: 'not_editor' as const,
    created_in_editor: false,
    exported_from_editor: false,
    day_cycle_stop_time: -1,
    edu_offer: 0,
    edu_features_enabled: false,
    edu_product_uuid: '',
    rain_level: 0,
    lightning_level: 0,
    has_confirmed_platform_locked_content: false,
    is_multiplayer: true,
    broadcast_to_lan: true,
    xbox_live_broadcast_mode: 0,
    platform_broadcast_mode: 0,
    enable_commands: true,
    is_texturepacks_required: false,
    gamerules: [{ name: 'showcoordinates', editable: false, type: 'bool', value: false }] as [
      { name: string; editable: boolean; type: 'bool'; value: boolean }
    ],
    experiments: [] as [],
    experiments_previously_used: false,
    bonus_chest: false,
    map_enabled: false,
    permission_level: 'visitor' as const,
    server_chunk_tick_range: 4,
    has_locked_behavior_pack: false,
    has_locked_resource_pack: false,
    is_from_locked_world_template: false,
    msa_gamertags_only: false,
    is_from_world_template: false,
    is_world_template_option_locked: false,
    only_spawn_v1_villagers: false,
    persona_disabled: false,
    custom_skins_disabled: false,
    emote_chat_muted: false,
    game_version: '*',
    limited_world_width: 0,
    limited_world_length: 0,
    is_new_nether: false,
    edu_resource_uri: { button_name: '', link_uri: '' },
    experimental_gameplay_override: false,
    chat_restriction_level: 'none' as const,
    disable_player_interactions: false,
    level_id: '',
    world_name: 'MCXboxBroadcast',
    premium_world_template_id: '',
    is_trial: false,
    rewind_history_size: 0,
    server_authoritative_block_breaking: false,
    current_tick: 0n,
    enchantment_seed: 0,
    block_properties: [] as [],
    multiplayer_correlation_id: '',
    server_authoritative_inventory: false,
    engine: '',
    property_data: comp({}),
    block_pallette_checksum: 0n,
    world_template_id: '00000000-0000-0000-0000-000000000000',
    client_side_generation: false,
    block_network_ids_are_hashes: false,
    server_controlled_sound: false,
    has_server_join_info: false,
    server_identifier: '',
    scenario_identifier: '',
    world_identifier: '',
    owner_identifier: ''
  }
}

/**
 * Minimal Bedrock path over NetherNet WebRTC data channel: login → resource packs → transfer → close.
 */
export class BedrockRedirect {
  private serializer: ReturnType<typeof createSerializer>
  private deserializer: ReturnType<typeof createDeserializer>
  private frameProto: number
  private codecVersionName: string
  private compressionReady = false
  /**
   * Redirect FSM — if transfer never logs, grep logs for {@code state=} / {@code waitingFor=}.
   */
  private flowState:
    | 'initial'
    | 'waitingForLogin'
    | 'sent_login_phase'
    | 'await_resource_completed'
    | 'transfer_sent'
    | 'closed' = 'initial'
  private waitingFor = 'request_network_settings or login'
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  closed = false

  private setFlowState(
    s:
      | 'initial'
      | 'waitingForLogin'
      | 'sent_login_phase'
      | 'await_resource_completed'
      | 'transfer_sent'
      | 'closed',
    wait: string
  ): void {
    this.flowState = s
    this.waitingFor = wait
    this.log.debug(`[BedrockRedirect] state=${this.flowState} waitingFor=${this.waitingFor}`)
  }

  constructor(
    private readonly log: Logger,
    private readonly target: BedrockRedirectTarget,
    private readonly conn: Connection
  ) {
    this.codecVersionName = target.versionName
    this.frameProto = target.protocolVersion
    this.serializer = createSerializer(target.versionName)
    this.deserializer = createDeserializer(target.versionName)
    this.setFlowState('initial', 'request_network_settings or login')
  }

  /**
   * Zentrales Outbound-Framing: vor {@code network_settings} nur VarInt+Länge, danach {@code 0xff}+VarInt+Payload.
   * @param wireCompressionHeader {@code false} erzwingt Pre-Handshake-Rahmen (nur {@code network_settings}).
   */
  private sendPacketBuffer(gamePacket: Buffer, wireCompressionHeader?: boolean): void {
    if (this.closed) return
    const useHdr = wireCompressionHeader !== undefined ? wireCompressionHeader : this.compressionReady
    const framed = frameOutboundBedrockPacket(gamePacket, useHdr)
    try {
      this.conn.send(framed)
    } catch (e) {
      this.log.error('[BedrockRedirect] sendPacketBuffer failed', e)
    }
  }

  private sendNamed(name: string, params: Record<string, unknown>): void {
    if (this.closed) return
    try {
      const pkt = this.serializer.createPacketBuffer({ name, params })
      this.sendPacketBuffer(pkt)
    } catch (e) {
      this.log.error(`[BedrockRedirect] encode ${name} failed`, e)
    }
  }

  private framerClient(): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const minecraftData = require('minecraft-data')('bedrock_' + this.codecVersionName) as {
      supportFeature: (n: string) => boolean
    }
    return {
      batchHeader: 0xfe,
      compressionAlgorithm: 'deflate',
      compressionLevel: bpDefaultOptions.compressionLevel,
      compressionThreshold: bpDefaultOptions.compressionThreshold,
      compressionHeader: 0,
      features: { compressorInHeader: minecraftData.supportFeature('compressorInPacketHeader') },
      compressionReady: this.compressionReady
    }
  }

  private applyClientProtocol(clientProtocol: number): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Versions } = require('bedrock-protocol/src/options') as { Versions: Record<string, number> }
    let vn = this.codecVersionName
    for (const [name, pv] of Object.entries(Versions)) {
      if (pv === clientProtocol) {
        vn = name
        break
      }
    }
    if (!Versions[vn]) {
      this.log.warn(
        `[BedrockRedirect] unknown client protocol ${clientProtocol} — keeping codec ${this.codecVersionName} (advertised ${this.target.protocolVersion})`
      )
      return
    }
    if (vn !== this.codecVersionName || clientProtocol !== this.frameProto) {
      this.log.info(`[BedrockRedirect] codec ${this.codecVersionName} → ${vn} (proto ${clientProtocol})`)
      this.codecVersionName = vn
      this.frameProto = clientProtocol
      this.serializer = createSerializer(vn)
      this.deserializer = createDeserializer(vn)
    }
  }

  /**
   * Ingest raw bytes from the nethernet {@link Server} `encapsulated` event (reliable channel).
   * Wire format: repeated **VarInt length + Bedrock game packet** (packet id = first VarInt in payload).
   */
  receiveEncapsulated(data: Buffer): void {
    if (this.closed) {
      this.log.debug('[BedrockRedirect] ingest exit: closed')
      return
    }
    try {
      const buf = Buffer.from(data)
      this.log.debug(
        `[BedrockRedirect] rx len=${buf.length} firstBytes=${buf.subarray(0, 16).toString('hex')}`
      )
      const parseBuf = this.compressionReady ? this.parseIncomingPayload(buf) : buf
      this.handleIncomingBuffer(parseBuf)
    } catch (err) {
      this.log.error('[BedrockRedirect] parser failed', err)
    }
  }

  /** Explicit entry from WebRTC wiring (same as {@link receiveEncapsulated}). */
  handleDataChannelMessage(buf: Buffer): void {
    this.receiveEncapsulated(buf)
  }

  /**
   * Nach {@code network_settings}: erst Compression-Header-Byte, dann VarInt-Frames (niemals {@code 0xff} als Längen-VarInt).
   */
  private parseIncomingPayload(buf: Buffer): Buffer {
    if (buf.length === 0) return buf

    const compressionHeader = buf[0]!
    this.log.debug(`[BedrockRedirect] compression header=0x${compressionHeader.toString(16)}`)

    const rest = buf.subarray(1)

    if (compressionHeader === 0xff) {
      this.log.debug(`[BedrockRedirect] compression=none wirePayloadLen=${rest.length}`)
      return rest
    }

    if (compressionHeader === 0x00) {
      this.log.debug(`[BedrockRedirect] compression=zlib compressedLen=${rest.length}`)
      try {
        const inflated = inflateRawSync(rest, { chunkSize: 512_000 })
        this.log.debug(`[BedrockRedirect] zlib inflated len=${inflated.length}`)
        return inflated
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.log.error(`[BedrockRedirect] zlib inflate failed error=${msg}`)
        return Buffer.alloc(0)
      }
    }

    if (compressionHeader === 0x01) {
      this.log.warn(
        `[BedrockRedirect] compression=snappy not implemented len=${rest.length} — packet skipped`
      )
      return Buffer.alloc(0)
    }

    this.log.warn(
      `[BedrockRedirect] unknown compression header=0x${compressionHeader.toString(16)} len=${buf.length}`
    )
    return Buffer.alloc(0)
  }

  private handleIncomingBuffer(buf: Buffer): void {
    this.log.debug(`[BedrockRedirect] handleIncomingBuffer len=${buf.length}`)

    let offset = 0

    while (offset < buf.length) {
      const len = readUnsignedVarInt(buf, offset)

      this.log.debug(
        `[BedrockRedirect] frame length=${len.value} lengthVarintBytes=${len.offset - offset}`
      )

      offset = len.offset

      if (len.value <= 0 || offset + len.value > buf.length) {
        this.log.warn(`[BedrockRedirect] invalid frame length=${len.value} remaining=${buf.length - offset}`)
        return
      }

      const payload = buf.subarray(offset, offset + len.value)

      this.log.debug(`[BedrockRedirect] frame payloadFirstBytes=${payload.subarray(0, 16).toString('hex')}`)

      offset += len.value

      this.handlePacket(payload)
    }
  }

  private handlePacket(payload: Buffer): void {
    if (this.flowState === 'transfer_sent' || this.flowState === 'closed') {
      this.log.debug(`[BedrockRedirect] ignoring inbound after transfer state=${this.flowState}`)
      return
    }

    this.log.debug(`[BedrockRedirect] handlePacket len=${payload.length}`)

    let id: { value: number; offset: number }
    try {
      id = readUnsignedVarInt(payload, 0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log.warn(`[BedrockRedirect] packet id VarInt failed len=${payload.length} (${msg})`)
      return
    }

    const packetId = id.value

    const idName =
      packetId === 193 ? 'request_network_settings' : packetId === 1 ? 'login' : 'unknown'
    this.log.debug(`[BedrockRedirect] packet id=${packetId} name=${idName} idBytes=${id.offset}`)

    if (packetId === 193) {
      if (!this.compressionReady) {
        if (payload.length < id.offset + 4) {
          this.log.warn(`[BedrockRedirect] request_network_settings too short len=${payload.length}`)
          return
        }

        const protocol = payload.readInt32BE(id.offset)

        this.log.info(`[BedrockRedirect] request_network_settings received protocol=${protocol}`)

        this.sendNetworkSettingsHandshake(protocol)
        return
      }
    }

    if (packetId === 1) {
      void this.handleLoginPacket(payload, id.offset).catch((e) =>
        this.log.error('[BedrockRedirect] handleLoginPacket failed', e)
      )
      return
    }

    try {
      const packets = this.extractGamePackets(payload)
      if (packets.length === 0) {
        this.log.debug(
          `[BedrockRedirect] extractGamePackets empty idHint=${packetId} compressionReady=${this.compressionReady}`
        )
        return
      }
      for (const { name, params } of packets) {
        this.log.debug(`[BedrockRedirect] packet name=${name} state=${this.flowState}`)
        void this.dispatch(name, params)
      }
    } catch (e) {
      this.log.error('[BedrockRedirect] handlePacket downstream failed', e)
    }
  }

  /** Redirect-only: keine JWT-/Chain-Verifizierung (Raw-Paket oder dispatch). */
  private async handleLoginPacket(payload: Buffer, idOffset: number): Promise<void> {
    if (payload.length < idOffset + 4) {
      this.log.warn(`[BedrockRedirect] login packet too short len=${payload.length}`)
      return
    }
    await this.finalizeRedirectLogin(payload.readInt32BE(idOffset))
  }

  /** Gemeinsamer Redirect-Login ohne Auth — Rohpaket und deserialisiert (Batch). */
  private async finalizeRedirectLogin(protocol: number): Promise<void> {
    this.log.info(`[BedrockRedirect] login received protocol=${protocol}`)

    const expectedProtocol = this.target.protocolVersion
    if (protocol !== expectedProtocol) {
      this.log.warn(`[BedrockRedirect] protocol mismatch client=${protocol} expected=${expectedProtocol}`)
      return
    }

    if (!this.compressionReady) {
      this.log.warn('[BedrockRedirect] login before network_settings — ignored')
      return
    }

    if (this.flowState !== 'waitingForLogin') {
      this.log.debug(`[BedrockRedirect] login ignored state=${this.flowState}`)
      return
    }

    this.log.info('[BedrockRedirect] login accepted redirectOnly=true verifyAuth=false')
    await this.sendRedirectAfterLogin()
  }

  private async sendRedirectAfterLogin(): Promise<void> {
    this.sendNamed('play_status', { status: 'login_success' })
    this.sendNamed('resource_packs_info', {
      must_accept: false,
      has_addons: false,
      has_scripts: false,
      disable_vibrant_visuals: true,
      world_template: { uuid: '00000000-0000-0000-0000-000000000000', version: '*' },
      texture_packs: []
    })
    this.setFlowState('sent_login_phase', 'resource_pack_client_response (have_all_packs → completed)')
  }

  /** Erstes Paket vor Kompression: nur VarInt-Rahmen (ohne {@code 0xff}). */
  private sendNetworkSettingsHandshake(protocol: number): void {
    this.applyClientProtocol(protocol)
    try {
      const pkt = this.serializer.createPacketBuffer({
        name: 'network_settings',
        params: {
          compression_threshold: 0,
          compression_algorithm: 'deflate',
          client_throttle: false,
          client_throttle_threshold: 0,
          client_throttle_scalar: 0
        }
      })
      this.sendPacketBuffer(pkt, false)
      this.log.info('[BedrockRedirect] network_settings sent')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.log.error(`[BedrockRedirect] network_settings encode failed error=${msg}`)
      return
    }
    this.compressionReady = true
    this.setFlowState('waitingForLogin', 'login')
  }

  /**
   * Plain game packet first; **batch/compression** (`0xfe` batch) only after {@link compressionReady}
   * (post-{@code network_settings}), matching Bedrock handshake order.
   */
  private extractGamePackets(game: Buffer): Array<{ name: string; params: Record<string, unknown> }> {
    try {
      const d = this.deserializer.parsePacketBuffer(game)
      return [{ name: d.data.name, params: d.data.params }]
    } catch {
      /* try batch / compressed only after handshake */
    }
    if (this.compressionReady && game.length >= 2 && game[0] === 0xfe) {
      try {
        const clientMock = this.framerClient()
        const list = Framer.decode(clientMock, game)
        const out: Array<{ name: string; params: Record<string, unknown> }> = []
        for (const raw of list) {
          try {
            const d = this.deserializer.parsePacketBuffer(raw)
            out.push({ name: d.data.name, params: d.data.params })
          } catch {
            /* skip sub-packet */
          }
        }
        if (out.length > 0) {
          this.log.debug(`[BedrockRedirect] ${out.length} packet(s) from batch wrapper`)
          return out
        }
      } catch {
        /* fall through */
      }
    }
    const pid = peekBedrockPacketId(game)
    this.log.debug(
      `[BedrockRedirect] unknown packet id=${pid} len=${game.length} firstBytes=${firstBytesHex(game)}`
    )
    return []
  }

  private async dispatch(name: string, params: Record<string, unknown>): Promise<void> {
    if (this.flowState === 'transfer_sent' || this.flowState === 'closed') {
      this.log.debug(`[BedrockRedirect] ignoring dispatch after transfer name=${name}`)
      return
    }

    switch (name) {
      case 'request_network_settings': {
        const ver = params.client_protocol as number
        this.applyClientProtocol(ver)
        this.log.info(`[BedrockRedirect] request_network_settings received protocol=${ver}`)
        try {
          const pkt = this.serializer.createPacketBuffer({
            name: 'network_settings',
            params: {
              compression_threshold: 0,
              compression_algorithm: 'deflate',
              client_throttle: false,
              client_throttle_threshold: 0,
              client_throttle_scalar: 0
            }
          })
          this.sendPacketBuffer(pkt, false)
          this.log.info('[BedrockRedirect] network_settings sent')
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.log.error(`[BedrockRedirect] network_settings encode failed error=${msg}`)
          return
        }
        this.compressionReady = true
        this.setFlowState('waitingForLogin', 'login')
        return
      }
      case 'login': {
        void this.finalizeRedirectLogin(params.protocol_version as number).catch((e) =>
          this.log.error('[BedrockRedirect] finalizeRedirectLogin failed', e)
        )
        return
      }
      case 'client_cache_status':
        return
      case 'client_to_server_handshake':
        return
      case 'resource_pack_client_response': {
        this.handleResourcePackClientResponse(params)
        return
      }
      default: {
        if (
          name === 'request_chunk_radius' ||
          name === 'serverbound_loading_screen'
        ) {
          this.log.debug(`[BedrockRedirect] ignoring packet name=${name}`)
          return
        }
        this.log.warn(
          `[BedrockRedirect] unexpected packet name=${name} state=${this.flowState} waitingFor=${this.waitingFor}`
        )
        return
      }
    }
  }

  private handleResourcePackClientResponse(params: Record<string, unknown>): void {
    const st = params.response_status as string
    if (st === 'have_all_packs') {
      this.setFlowState('await_resource_completed', 'resource_pack_client_response (completed)')
      this.sendNamed('resource_pack_stack', {
        must_accept: false,
        resource_packs: [],
        game_version: '*',
        experiments: [],
        experiments_previously_used: false,
        has_editor_packs: false
      })
      return
    }
    if (st === 'completed') {
      this.sendNamed('start_game', buildStartGameParams())
      this.sendNamed('transfer', {
        server_address: this.target.host,
        port: this.target.port,
        reload_world: false
      })
      this.log.info(
        `[BedrockRedirect] redirect/transfer sent ip=${this.target.host} port=${this.target.port}`
      )
      this.setFlowState('transfer_sent', '(none — closing)')
      this.closeAfterTransfer()
      return
    }
    if (st !== 'none') {
      this.sendNamed('disconnect', {
        reason: 'unknown',
        hide_disconnect_reason: false,
        message: 'disconnectionScreen.resourcePack',
        filtered_message: ''
      })
      this.close()
    }
  }

  private closeAfterTransfer(): void {
    if (this.closeTimer !== null) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      this.log.info('[BedrockRedirect] closed after transfer')
      this.setFlowState('closed', '(closed)')
      this.close()
    }, 1500)
  }

  close(): void {
    if (this.closed) return
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.closed = true
    try {
      this.conn.close()
    } catch {
      /* ignore */
    }
  }
}

export function attachBedrockRedirect(
  netherServer: Server,
  log: Logger,
  getTarget: () => BedrockRedirectTarget
): void {
  const redirects = new Map<string, BedrockRedirect>()
  const noRxTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** nethernet does not wire {@link Connection.unreliable} through `encapsulated`; hook once for debug + forwarding. */
  const unreliableForwardHooked = new WeakSet<Connection>()

  function clearNoRxTimer(key: string): void {
    const t = noRxTimers.get(key)
    if (t) {
      clearTimeout(t)
      noRxTimers.delete(key)
    }
  }

  function hookUnreliableForward(conn: Connection): void {
    if (unreliableForwardHooked.has(conn)) return
    const unr = conn.unreliable
    if (!unr) return
    unreliableForwardHooked.add(conn)
    unr.onMessage((msg: string | Buffer | ArrayBuffer) => {
      const buf = Buffer.from(msg as ArrayBuffer)
      log.debug(`[WebRTC] unreliable dc rx len=${buf.length}`)
      try {
        const redirect = getOrCreateRedirect(conn)
        redirect.handleDataChannelMessage(buf)
      } catch (err) {
        log.error('[WebRTC] BedrockRedirect unreliable forwarding failed', err)
      }
    })
  }

  function getOrCreateRedirect(conn: Connection): BedrockRedirect {
    const key = conn.address.toString()
    let redirect = redirects.get(key)
    if (redirect) {
      hookUnreliableForward(conn)
      return redirect
    }

    redirect = new BedrockRedirect(log, getTarget(), conn)
    redirects.set(key, redirect)
    log.info('[WebRTC] data channel open')
    log.debug(`[BedrockRedirect] attached connection=${key}`)
    clearNoRxTimer(key)
    noRxTimers.set(
      key,
      setTimeout(() => {
        noRxTimers.delete(key)
        log.warn(
          `[BedrockRedirect] CHECKPOINT: no rx within 15s after data channel open connection=${key} — client sent no Bedrock over encapsulation, or channel wiring broken`
        )
      }, 15_000)
    )
    hookUnreliableForward(conn)
    return redirect
  }

  netherServer.on('openConnection', (conn: Connection) => {
    getOrCreateRedirect(conn)
  })

  netherServer.on('closeConnection', (connectionId: bigint, _reason?: string) => {
    const key = connectionId.toString()
    clearNoRxTimer(key)
    redirects.get(key)?.close()
    redirects.delete(key)
  })

  netherServer.on('encapsulated', (data: Buffer, connectionId: bigint) => {
    const key = connectionId.toString()
    clearNoRxTimer(key)

    log.debug(`[WebRTC] reliable dc rx len=${data.length}`)

    const conn = netherServer.connections.get(connectionId)
    if (!conn) {
      log.warn(
        `[WebRTC] encapsulated but Server.connections has no entry id=${key} — cannot attach BedrockRedirect yet`
      )
      return
    }

    try {
      const redirect = getOrCreateRedirect(conn)
      redirect.handleDataChannelMessage(data)
    } catch (err) {
      log.error('[WebRTC] BedrockRedirect forwarding failed', err)
    }
  })
}
