import { addChangeHandler, Atom, deref, swap } from '@libre/atom'
import { BotInstance } from 'kaiheila-bot-root/dist/BotInstance'
import { MessageSource } from 'kaiheila-bot-root/dist/MessageSource/MessageSource'
import {
  KHEventPacket,
  KHHelloPacket,
  KHOpcode,
  KHPacket,
  KHPingPacket,
} from 'kaiheila-bot-root/dist/types/kaiheila/packet'
import * as WebSocket from 'ws'
import { transform } from './state-machine'
import { Action, Actions, Effect, Effects, State, States, TimeoutKey, TTimeout } from './types'
import { inflate } from './utils'

export default class WebSocketFSMSource extends MessageSource {
  type = 'websocket-fsm'
  ws?: WebSocket
  url?: string
  sessionId?: string

  private wsState: Atom<State>

  timeouts = new Map<TimeoutKey, TTimeout>()

  eventListeners = new Map<string, (event: unknown) => void>()

  constructor(self: BotInstance, compress = true) {
    super(self)
    this.wsState = Atom.of(
      States.INITIAL({
        compress: compress,
        retryCount: 0,
        helloTimeoutMillis: 6000,
        heartbeatIntervalMillis: 30000,
        heartbeatTimeoutMillis: 6000,
      }),
    )

    addChangeHandler(this.wsState, 'wsStateHandler', ({ previous, current }) => {
      if (previous.tag !== current.tag) {
        console.debug(`WebSocket state changed: ${previous.tag} -> ${current.tag}`)
      }
    })
  }

  async connect(): Promise<boolean> {
    this.transition(Actions.PULL_GATEWAY())
    return true
  }

  currentState(): State {
    return deref(this.wsState)
  }

  private nukeTimeout(k: TimeoutKey) {
    const t = this.timeouts.get(k)
    if (t) clearTimeout(t)
  }

  private addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    handler: (event: unknown) => void,
  ) {
    if (this.ws) {
      this.ws.addListener(type, handler)
      this.eventListeners.set(type, handler)
    }
  }

  private clearEventListeners() {
    this.eventListeners.forEach((h, k) => {
      this.ws?.removeListener(k, h)
    })
    this.eventListeners.clear()
  }

  private clearTimeouts() {
    this.timeouts.forEach((v, k) => this.nukeTimeout(k))
  }

  private transition(a: Action) {
    const [newState, effects] = transform(a, deref(this.wsState))
    swap(this.wsState, () => newState)
    effects.forEach(this.handleEffect.bind(this))
  }

  // here gives the way to handle effects (where happens when state changes)
  // basically **effect** means side effect which changes the attribute of this object itself
  private handleEffect(e: Effect) {
    const self = this
    return Effects.match(e, {
      PULL_GATEWAY: ({ compress }) => {
        self.botInstance.API.gateway
          .index(compress ? 1 : 0)
          .then(({ url }) => {
            self.url = url
            self.transition(Actions.CONNECT_GATEWAY())
          })
          .catch(() => {
            console.error('Getting gateway error')
            self.transition(Actions.CLOSE())
            self.transition(Actions.RECONNECT())
          })
      },

      CONNECT_WS: (conn) => {
        if (self.ws) {
          self.clearEventListeners()
          self.clearTimeouts()
          self.ws.close()
        }

        if (!self.url) {
          self.transition(Actions.PULL_GATEWAY())
          return
        }

        const sessionIdPart = self.sessionId
          ? `&resule=1&sessionId=${self.sessionId}&sn=${self.sn}`
          : ''
        self.ws = new WebSocket(self.url + sessionIdPart)

        const onOpen = () => self.transition(Actions.OPEN())
        self.addEventListener('open', onOpen)

        const onClose = () => {
          self.transition(conn.onClose)
          self.transition(Actions.RECONNECT())
        }
        self.addEventListener('close', onClose)

        const onMessage = (ev: unknown) => {
          self
            .dataParse(ev, conn.compress)
            .then((packet) => {
              if (packet) {
                switch (packet.s) {
                  case KHOpcode.HELLO:
                    self.handleHelloPacket(packet)
                    break
                  case KHOpcode.EVENT:
                    self.onEventArrive(packet as KHEventPacket)
                    break
                  case KHOpcode.PING:
                    console.warn('Receive Wrong Direction Packet!')
                    break
                  case KHOpcode.PONG:
                    self.transition(conn.onPongMessage)
                    break
                  case KHOpcode.RECONNECT:
                    // TODO: General retry
                    self.clearTimeouts()
                    self.sn = 0
                    self.sessionId = undefined
                    self.buffer = []
                    console.warn('Receive Reconnect Packet : ' + JSON.stringify(packet.d))
                    self.transition(Actions.CLOSE())
                    self.transition(Actions.RECONNECT())
                    break
                  case KHOpcode.RESUME_ACK:
                    break
                  default:
                    console.log(packet)
                    break
                }
              }
            })
            .catch((err) => {
              console.error('Parsing message error:', err)
              self.transition(Actions.CLOSE())
              self.transition(Actions.RECONNECT())
            })
        }
        self.addEventListener('message', onMessage)
        //TODO: handle on error
      },

      SCHEDULE_TIMEOUT: (t) => {
        self.timeouts.set(
          t.key,
          setTimeout(() => self.transition(t.onTimeout), t.timeoutMillis),
        )
      },

      SEND_PING: () => {
        if (self.ws) {
          self.ws.send(JSON.stringify({ s: KHOpcode.PING, sn: self.sn } as KHPingPacket))
        }
      },

      CLEAR_TIMEOUT: (t) => self.nukeTimeout(t.key),

      TRIGGER_ACTION: (a) => self.transition(a.action),
    })
  }

  private async dataParse(data: unknown, compress: boolean): Promise<KHPacket | undefined> {
    if (!data) {
      return undefined
    }
    if (compress && Buffer.isBuffer(data)) {
      return JSON.parse((await inflate(data)).toString()) as KHPacket
    } else {
      return JSON.parse((data as ArrayBufferLike).toString()) as KHPacket
    }
  }

  private handleHelloPacket(packet: KHHelloPacket) {
    switch (packet.d.code) {
      case 0:
        if (this.sessionId != packet.d.session_id) {
          this.buffer = []
          this.sn = 0
        }
        this.sessionId = packet.d.session_id
        this.transition(Actions.OPEN())
        break
      case 40100:
      case 40101:
      case 40102:
      case 40103:
        this.transition(Actions.CLOSE())
        this.transition(Actions.RECONNECT())
        break
      default:
        console.warn(`Receive ${packet.d.code}, Ignored`)
        break
    }
  }
}
