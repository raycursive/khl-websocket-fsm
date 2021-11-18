import unionize, { ofType, UnionOf } from 'unionize'

type WsContext = {
  compress: boolean
  sessionId?: string
  retryCount: number
  helloTimeoutMillis: number
  heartbeatIntervalMillis: number
  heartbeatTimeoutMillis: number
}

const States = unionize({
  INITIAL: ofType<WsContext>(),
  PULLING_GATEWAY: ofType<WsContext>(),
  CONNECTING: ofType<WsContext>(),
  OPEN: ofType<WsContext>(),
  CLOSED: ofType<WsContext>(),
  RECONNECTING: ofType<WsContext>(),
})

type State = UnionOf<typeof States>

const Actions = unionize({
  PULL_GATEWAY: {},
  CONNECT_GATEWAY: {},
  OPEN: {},
  CLOSE: {},
  HELLO_TIMEOUT: {},
  PING_TIMEOUT: {},
  PONG_TIMEOUT: {},
  HEARTBEAT: {},
  RECONNECT: {},
})

type Action = UnionOf<typeof Actions>

const TimeoutKeys = ['hello', 'gateway', 'ping', 'pong', 'connect'] as const
type TimeoutKey = typeof TimeoutKeys[number]

const Effects = unionize({
  PULL_GATEWAY: ofType<{ compress: boolean }>(),
  CONNECT_WS: ofType<{
    compress: boolean
    onOpen: Action
    onClose: Action
    onPongMessage: Action
  }>(),
  SCHEDULE_TIMEOUT: ofType<{
    key: TimeoutKey
    timeoutMillis: number
    onTimeout: Action
  }>(),
  SEND_PING: {},
  CLEAR_TIMEOUT: ofType<{ key: TimeoutKey }>(),
  TRIGGER_ACTION: ofType<{ action: Action }>(),
})

type Effect = UnionOf<typeof Effects>

type StateTransfer = (state: State) => [State, Effect[]]

type TTimeout = ReturnType<typeof setTimeout>

export {
  States,
  State,
  Actions,
  Action,
  Effects,
  Effect,
  StateTransfer,
  TimeoutKey,
  TimeoutKeys,
  TTimeout,
}
