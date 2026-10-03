export type ChannelKind = 'teams-web' | 'botframework';

/** Mensagem já normalizada por qualquer transport, no formato interno do agente. */
export interface InboundMessage {
  id: string;
  channel: ChannelKind;
  conversationId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
  isGroup: boolean;
  mentionsAgent: boolean;
  raw?: unknown;
}

export interface OutboundMessage {
  conversationId: string;
  text: string;
  /** Id da mensagem respondida (threading no Teams). */
  replyToId?: string;
  handoff?: boolean;
  /** Ids de anexos/cards; o adapter decide o formato nativo. */
  raw?: unknown;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface ChannelStatus {
  name: ChannelKind;
  running: boolean;
  detail: string;
}

export type InboundHandler = (message: InboundMessage) => Promise<void>;

/** Contrato único que os dois transports (Bot Framework e Teams Web) implementam. */
export interface Channel {
  readonly name: ChannelKind;
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SendResult>;
  status(): ChannelStatus;
}
