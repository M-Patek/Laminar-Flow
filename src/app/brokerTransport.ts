import {
  createMessage,
  getBrokerDiagnostics,
  getNextDeliveryCandidate,
  getUnreadCounts,
  listMessages,
  listPeers,
  markMessageDelivered,
  markMessageDone,
  markMessageRead,
  readBrokerSnapshot,
  resetBrokerState,
  upsertPeerState
} from "./broker.ts";
import type {
  BrokerDiagnostics,
  DeliveryCandidate,
  DuplexMessage,
  MsgStatus,
  PeerState
} from "./broker.ts";

export interface BrokerTransport {
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

export type BrokerTransportMode = "local" | "daemon";

export function createLocalBrokerTransport(workspaceDir: string): BrokerTransport {
  return {
    createMessage: (input) => createMessage(workspaceDir, input),
    listMessages: (query) => listMessages(workspaceDir, query),
    markMessageDelivered: (id) => markMessageDelivered(workspaceDir, id),
    markMessageRead: (id) => markMessageRead(workspaceDir, id),
    markMessageDone: (id) => markMessageDone(workspaceDir, id),
    upsertPeerState: (state) => upsertPeerState(workspaceDir, state),
    listPeers: () => listPeers(workspaceDir),
    getUnreadCounts: () => getUnreadCounts(workspaceDir),
    getNextDeliveryCandidate: (options) => getNextDeliveryCandidate(workspaceDir, options),
    getBrokerDiagnostics: (options) => getBrokerDiagnostics(workspaceDir, options),
    readBrokerSnapshot: () => readBrokerSnapshot(workspaceDir),
    resetBrokerState: () => resetBrokerState(workspaceDir)
  };
}

export function createDaemonBrokerTransport(): BrokerTransport {
  const unsupported = async (): Promise<never> => {
    throw new Error("Daemon broker transport is not implemented yet.");
  };

  return {
    createMessage: unsupported,
    listMessages: unsupported,
    markMessageDelivered: unsupported,
    markMessageRead: unsupported,
    markMessageDone: unsupported,
    upsertPeerState: unsupported,
    listPeers: unsupported,
    getUnreadCounts: unsupported,
    getNextDeliveryCandidate: unsupported,
    getBrokerDiagnostics: unsupported,
    readBrokerSnapshot: unsupported,
    resetBrokerState: unsupported
  };
}

export function resolveBrokerTransportMode(env = process.env): BrokerTransportMode {
  const mode = env.DUPLEX_BROKER_TRANSPORT?.trim().toLowerCase();
  if (!mode || mode === "local") {
    return "local";
  }
  if (mode === "daemon") {
    return "daemon";
  }
  throw new Error(`Unsupported broker transport mode: ${env.DUPLEX_BROKER_TRANSPORT}`);
}

export type { BrokerDiagnostics, DeliveryCandidate, DuplexMessage, MsgStatus, PeerState } from "./broker.ts";

