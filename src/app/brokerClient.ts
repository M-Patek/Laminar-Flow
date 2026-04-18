import {
  createDaemonBrokerTransport,
  createLocalBrokerTransport,
  resolveBrokerTransportMode
} from "./brokerTransport.ts";
import type {
  BrokerDiagnostics,
  BrokerTransport,
  DeliveryCandidate,
  DuplexMessage,
  MsgStatus,
  PeerState
} from "./brokerTransport.ts";

export interface BrokerClient {
  createMessage(input: {
    from: string;
    to: string;
    kind?: string;
    summary: string;
    ask: string;
    refs?: string[];
  }): Promise<DuplexMessage>;
  listMessages(query: { to?: string; from?: string; status?: MsgStatus }): Promise<DuplexMessage[]>;
  markMessageDelivered(id: string): Promise<DuplexMessage>;
  markMessageRead(id: string): Promise<DuplexMessage>;
  markMessageDone(id: string): Promise<DuplexMessage>;
  upsertPeerState(state: Partial<PeerState> & Pick<PeerState, "id">): Promise<PeerState>;
  listPeers(): Promise<PeerState[]>;
  getUnreadCounts(): Promise<Record<"left" | "right", number>>;
  getNextDeliveryCandidate(options?: { cooldownMs?: number; lastDeliveryAt?: number }): Promise<DeliveryCandidate | undefined>;
  getBrokerDiagnostics(options?: { cooldownMs?: number; lastDeliveryAt?: number }): Promise<BrokerDiagnostics>;
  readBrokerSnapshot(): Promise<{ messages: DuplexMessage[]; peers: PeerState[] }>;
  resetBrokerState(): Promise<void>;
}

export function createBrokerClient(transport: BrokerTransport): BrokerClient {
  return {
    createMessage: (input) => transport.createMessage(input),
    listMessages: (query) => transport.listMessages(query),
    markMessageDelivered: (id) => transport.markMessageDelivered(id),
    markMessageRead: (id) => transport.markMessageRead(id),
    markMessageDone: (id) => transport.markMessageDone(id),
    upsertPeerState: (state) => transport.upsertPeerState(state),
    listPeers: () => transport.listPeers(),
    getUnreadCounts: () => transport.getUnreadCounts(),
    getNextDeliveryCandidate: (options) => transport.getNextDeliveryCandidate(options),
    getBrokerDiagnostics: (options) => transport.getBrokerDiagnostics(options),
    readBrokerSnapshot: () => transport.readBrokerSnapshot(),
    resetBrokerState: () => transport.resetBrokerState()
  };
}

export function createLocalBrokerClient(workspaceDir: string): BrokerClient {
  return createBrokerClient(createLocalBrokerTransport(workspaceDir));
}

export function createConfiguredBrokerClient(workspaceDir: string, env = process.env): BrokerClient {
  const mode = resolveBrokerTransportMode(env);
  switch (mode) {
    case "local":
      return createBrokerClient(createLocalBrokerTransport(workspaceDir));
    case "daemon":
      return createBrokerClient(createDaemonBrokerTransport());
    default:
      return createBrokerClient(createLocalBrokerTransport(workspaceDir));
  }
}

export { createMessage, listMessages } from "./broker.ts";
export type {
  BrokerDiagnostics,
  BrokerTransport,
  BrokerTransportMode,
  DeliveryCandidate,
  DuplexMessage,
  MsgStatus,
  PeerState
};

