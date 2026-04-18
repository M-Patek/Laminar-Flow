import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type MsgKind = "handoff" | "question" | "decision" | "blocker" | "note";
export type MsgStatus = "unread" | "read" | "done";
export type PeerId = "left" | "right";
export type PeerRole = "lead" | "support";
export type PeerStatus = "idle" | "busy" | "integrating" | "waiting";

export interface DuplexMessage {
  id: string;
  from: string;
  to: string;
  kind: MsgKind;
  summary: string;
  ask: string;
  refs: string[];
  createdAt: string;
  status: MsgStatus;
  deliveredAt?: string;
  readAt?: string;
  doneAt?: string;
}

export interface PeerState {
  id: PeerId;
  role: PeerRole;
  status: PeerStatus;
  lastActivityAt: string;
}

interface BrokerState {
  messages: DuplexMessage[];
  peers: PeerState[];
}

export interface DeliveryCandidate {
  message: DuplexMessage;
  target: PeerId;
  merged: boolean;
}

export interface BrokerDiagnostics {
  peers: Record<PeerId, PeerState>;
  pending: Record<PeerId, number>;
  blockedReason: "none" | "cooldown" | "left_busy" | "right_busy" | "no_pending";
  cooldownRemainingMs: number;
  quietRemainingMs: Record<PeerId, number>;
  nextTarget?: PeerId;
  nextMerged: boolean;
  nextMessage?: Pick<DuplexMessage, "from" | "to" | "kind" | "summary">;
}

const QUIET_WINDOW_MS = 3200;
const brokerWriteQueues = new Map<string, Promise<void>>();

const DEFAULT_KIND: MsgKind = "note";
const DEFAULT_PEERS: PeerState[] = [
  { id: "left", role: "lead", status: "idle", lastActivityAt: new Date(0).toISOString() },
  { id: "right", role: "support", status: "idle", lastActivityAt: new Date(0).toISOString() }
];

export async function createMessage(
  workspaceDir: string,
  input: {
    from: string;
    to: string;
    kind?: string;
    summary: string;
    ask: string;
    refs?: string[];
  }
): Promise<DuplexMessage> {
  return mutateBrokerState(workspaceDir, async (store) => {
    const now = new Date().toISOString();
    const message: DuplexMessage = {
      id: `msg_${crypto.randomUUID()}`,
      from: input.from.trim(),
      to: input.to.trim(),
      kind: toMsgKind(input.kind),
      summary: input.summary.trim(),
      ask: input.ask.trim(),
      refs: (input.refs ?? []).map((value) => value.trim()).filter(Boolean),
      createdAt: now,
      status: "unread"
    };

    if (!message.from || !message.to || !message.summary || !message.ask) {
      throw new Error("send requires --from, --to, --summary, and --ask.");
    }

    store.messages.unshift(message);
    return message;
  });
}

export async function listMessages(
  workspaceDir: string,
  query: {
    to?: string;
    from?: string;
    status?: MsgStatus;
  }
): Promise<DuplexMessage[]> {
  const store = await readBrokerState(workspaceDir);
  return store.messages.filter((message) => {
    if (query.to && message.to !== query.to) {
      return false;
    }
    if (query.from && message.from !== query.from) {
      return false;
    }
    if (query.status && message.status !== query.status) {
      return false;
    }
    return true;
  });
}

export async function markMessageDelivered(workspaceDir: string, id: string): Promise<DuplexMessage> {
  return updateMessage(workspaceDir, id, (current) => ({
    ...current,
    deliveredAt: current.deliveredAt ?? new Date().toISOString()
  }));
}

export async function markMessageRead(workspaceDir: string, id: string): Promise<DuplexMessage> {
  return updateMessage(workspaceDir, id, (current) => ({
    ...current,
    status: current.status === "done" ? "done" : "read",
    readAt: current.readAt ?? new Date().toISOString()
  }));
}

export async function markMessageDone(workspaceDir: string, id: string): Promise<DuplexMessage> {
  return updateMessage(workspaceDir, id, (current) => ({
    ...current,
    status: "done",
    readAt: current.readAt ?? new Date().toISOString(),
    doneAt: new Date().toISOString()
  }));
}

export async function upsertPeerState(
  workspaceDir: string,
  state: Partial<PeerState> & Pick<PeerState, "id">
): Promise<PeerState> {
  return mutateBrokerState(workspaceDir, async (store) => {
    const index = store.peers.findIndex((peer) => peer.id === state.id);
    const previous = index === -1 ? DEFAULT_PEERS.find((peer) => peer.id === state.id) : store.peers[index];
    if (!previous) {
      throw new Error(`Unknown peer: ${state.id}`);
    }

    const next: PeerState = {
      id: state.id,
      role: state.role ?? previous.role,
      status: state.status ?? previous.status,
      lastActivityAt: state.lastActivityAt ?? new Date().toISOString()
    };

    if (index === -1) {
      store.peers.push(next);
    } else {
      store.peers[index] = next;
    }

    return next;
  });
}

export async function listPeers(workspaceDir: string): Promise<PeerState[]> {
  const store = await readBrokerState(workspaceDir);
  return store.peers;
}

export async function getUnreadCounts(workspaceDir: string): Promise<Record<PeerId, number>> {
  const store = await readBrokerState(workspaceDir);
  const counts: Record<PeerId, number> = {
    left: 0,
    right: 0
  };

  for (const message of store.messages) {
    if (message.status !== "unread") {
      continue;
    }
    if (message.to === "left" || message.to === "right") {
      counts[message.to] += 1;
    }
  }

  return counts;
}

export async function readBrokerSnapshot(workspaceDir: string): Promise<BrokerState> {
  return readBrokerState(workspaceDir);
}

export async function resetBrokerState(workspaceDir: string): Promise<void> {
  await mutateBrokerState(workspaceDir, async (store) => {
    store.messages = [];
    store.peers = DEFAULT_PEERS.map((peer) => ({ ...peer }));
  });
}

export async function getNextDeliveryCandidate(
  workspaceDir: string,
  options?: { cooldownMs?: number; lastDeliveryAt?: number }
): Promise<DeliveryCandidate | undefined> {
  const store = await readBrokerState(workspaceDir);
  const pending = store.messages.filter((message) => !message.deliveredAt);
  if (pending.length === 0) {
    return undefined;
  }

  const cooldownMs = options?.cooldownMs ?? 1800;
  const lastDeliveryAt = options?.lastDeliveryAt ?? 0;
  if (Date.now() - lastDeliveryAt < cooldownMs) {
    return undefined;
  }

  const leftPeer = store.peers.find((peer) => peer.id === "left") ?? DEFAULT_PEERS[0];
  const rightPeer = store.peers.find((peer) => peer.id === "right") ?? DEFAULT_PEERS[1];
  const leftBusy = isPeerBusy(leftPeer, Date.now());
  const rightBusy = isPeerBusy(rightPeer, Date.now());

  const toLead = pending.filter((message) => message.to === "left");
  const fromLead = pending.filter((message) => message.from === "left" && message.to === "right");
  if (toLead.length > 0 && fromLead.length > 0 && !leftBusy) {
    return {
      message: buildLeadMergeMessage(fromLead[0]!, toLead[0]!),
      target: "left",
      merged: true
    };
  }

  if (toLead.length > 0 && !leftBusy) {
    return {
      message: toLead[0]!,
      target: "left",
      merged: false
    };
  }

  const toSupport = pending.filter((message) => message.to === "right");
  if (toSupport.length > 0 && !rightBusy) {
    return {
      message: toSupport[0]!,
      target: "right",
      merged: false
    };
  }

  return undefined;
}

export async function getBrokerDiagnostics(
  workspaceDir: string,
  options?: { cooldownMs?: number; lastDeliveryAt?: number }
): Promise<BrokerDiagnostics> {
  const store = await readBrokerState(workspaceDir);
  const peers = {
    left: store.peers.find((peer) => peer.id === "left") ?? DEFAULT_PEERS[0],
    right: store.peers.find((peer) => peer.id === "right") ?? DEFAULT_PEERS[1]
  };
  const pendingMessages = store.messages.filter((message) => !message.deliveredAt);
  const pending: Record<PeerId, number> = { left: 0, right: 0 };
  for (const message of pendingMessages) {
    if (message.to === "left" || message.to === "right") {
      pending[message.to] += 1;
    }
  }

  const cooldownMs = options?.cooldownMs ?? 1800;
  const lastDeliveryAt = options?.lastDeliveryAt ?? 0;
  const now = Date.now();
  const leftBusy = isPeerBusy(peers.left, now);
  const rightBusy = isPeerBusy(peers.right, now);
  const cooldownRemainingMs = Math.max(0, cooldownMs - (now - lastDeliveryAt));
  const cooldownActive = cooldownRemainingMs > 0;
  const quietRemainingMs: Record<PeerId, number> = {
    left: getPeerQuietRemainingMs(peers.left, now),
    right: getPeerQuietRemainingMs(peers.right, now)
  };
  const candidate = await getNextDeliveryCandidate(workspaceDir, options);

  let blockedReason: BrokerDiagnostics["blockedReason"] = "none";
  if (pendingMessages.length === 0) {
    blockedReason = "no_pending";
  } else if (!candidate && cooldownActive) {
    blockedReason = "cooldown";
  } else if (!candidate && pending.left > 0 && leftBusy) {
    blockedReason = "left_busy";
  } else if (!candidate && pending.right > 0 && rightBusy) {
    blockedReason = "right_busy";
  }

  return {
    peers,
    pending,
    blockedReason,
    cooldownRemainingMs,
    quietRemainingMs,
    nextTarget: candidate?.target,
    nextMerged: candidate?.merged ?? false,
    nextMessage: candidate
      ? {
          from: candidate.message.from,
          to: candidate.message.to,
          kind: candidate.message.kind,
          summary: candidate.message.summary
        }
      : undefined
  };
}

async function updateMessage(
  workspaceDir: string,
  id: string,
  updater: (message: DuplexMessage) => DuplexMessage
): Promise<DuplexMessage> {
  return mutateBrokerState(workspaceDir, async (store) => {
    const index = store.messages.findIndex((message) => message.id === id);
    if (index === -1) {
      throw new Error(`Message not found: ${id}`);
    }

    const updated = updater(store.messages[index]!);
    store.messages[index] = updated;
    return updated;
  });
}

async function readBrokerState(workspaceDir: string): Promise<BrokerState> {
  const brokerPath = getBrokerStatePath(workspaceDir);
  await mkdir(path.dirname(brokerPath), { recursive: true });

  try {
    const raw = await readFile(brokerPath, "utf8");
    try {
      return normalizeBrokerState(JSON.parse(raw) as { messages?: unknown[]; peers?: unknown[] });
    } catch (error) {
      if (error instanceof SyntaxError) {
        const corruptPath = `${brokerPath}.corrupt-${Date.now()}`;
        await rename(brokerPath, corruptPath).catch(() => undefined);
        return {
          messages: [],
          peers: DEFAULT_PEERS.slice()
        };
      }
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const migrated = await migrateLegacyMailbox(workspaceDir);
  if (migrated) {
    await writeBrokerState(workspaceDir, migrated);
    return migrated;
  }

  return {
    messages: [],
    peers: DEFAULT_PEERS.slice()
  };
}

function normalizeBrokerState(input: { messages?: unknown[]; peers?: unknown[] }): BrokerState {
  return {
    messages: Array.isArray(input.messages) ? input.messages.map(normalizeMessage) : [],
    peers: normalizePeers(input.peers)
  };
}

function normalizePeers(input: unknown[] | undefined): PeerState[] {
  const seen = new Map<PeerId, PeerState>();
  for (const fallback of DEFAULT_PEERS) {
    seen.set(fallback.id, { ...fallback });
  }

  for (const raw of input ?? []) {
    const candidate = (raw ?? {}) as Partial<PeerState>;
    const id = candidate.id;
    if (id !== "left" && id !== "right") {
      continue;
    }

    seen.set(id, {
      id,
      role: candidate.role === "lead" || candidate.role === "support" ? candidate.role : seen.get(id)!.role,
      status:
        candidate.status === "idle" ||
        candidate.status === "busy" ||
        candidate.status === "integrating" ||
        candidate.status === "waiting"
          ? candidate.status
          : seen.get(id)!.status,
      lastActivityAt: candidate.lastActivityAt ?? seen.get(id)!.lastActivityAt
    });
  }

  return [seen.get("left")!, seen.get("right")!];
}

function normalizeMessage(input: unknown): DuplexMessage {
  const candidate = (input ?? {}) as Partial<DuplexMessage> & { body?: string };
  return {
    id: candidate.id ?? `msg_${crypto.randomUUID()}`,
    from: candidate.from ?? "unknown",
    to: candidate.to ?? "unknown",
    kind: toMsgKind(candidate.kind),
    summary: candidate.summary ?? "(no summary)",
    ask: candidate.ask ?? candidate.body ?? "(no ask)",
    refs: Array.isArray(candidate.refs) ? candidate.refs.map((value) => String(value)) : [],
    createdAt: candidate.createdAt ?? new Date().toISOString(),
    status: candidate.status ? toMsgStatus(candidate.status) : "unread",
    deliveredAt: candidate.deliveredAt,
    readAt: candidate.readAt,
    doneAt: candidate.doneAt
  };
}

async function writeBrokerState(workspaceDir: string, store: BrokerState): Promise<void> {
  const brokerPath = getBrokerStatePath(workspaceDir);
  await mkdir(path.dirname(brokerPath), { recursive: true });
  const tempPath = `${brokerPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await replaceFileRobust(tempPath, brokerPath);
}

async function migrateLegacyMailbox(workspaceDir: string): Promise<BrokerState | undefined> {
  const legacyPath = getLegacyMailboxPath(workspaceDir);
  if (!existsSync(legacyPath)) {
    return undefined;
  }

  const raw = await readFile(legacyPath, "utf8");
  const parsed = JSON.parse(raw) as { messages?: unknown[] };
  return {
    messages: Array.isArray(parsed.messages) ? parsed.messages.map(normalizeMessage) : [],
    peers: DEFAULT_PEERS.slice()
  };
}

function getBrokerStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, ".duplex", "broker", "state.json");
}

function getLegacyMailboxPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".duplex", "mailbox", "messages.json");
}

function isPeerBusy(peer: PeerState, now: number): boolean {
  return getPeerQuietRemainingMs(peer, now) > 0;
}

function getPeerQuietRemainingMs(peer: PeerState, now: number): number {
  if (peer.status === "busy" || peer.status === "integrating") {
    const lastActivityAt = Date.parse(peer.lastActivityAt);
    if (!Number.isNaN(lastActivityAt)) {
      return Math.max(0, QUIET_WINDOW_MS - (now - lastActivityAt));
    }
  }

  return 0;
}

function buildLeadMergeMessage(primary: DuplexMessage, secondary: DuplexMessage): DuplexMessage {
  return {
    ...primary,
    id: `${primary.id}__merge__${secondary.id}`,
    from: "merge",
    to: "left",
    kind: "note",
    summary: `Primary from ${primary.from}: ${primary.summary}`,
    ask: `Continue the lead thread first. Also absorb support input: ${secondary.summary}. Secondary ask: ${secondary.ask}`,
    refs: uniqueRefs([...primary.refs, ...secondary.refs]).slice(0, 4),
    deliveredAt: undefined
  };
}

function uniqueRefs(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function toMsgKind(value: string | undefined): MsgKind {
  if (!value) {
    return DEFAULT_KIND;
  }
  if (value === "handoff" || value === "question" || value === "decision" || value === "blocker" || value === "note") {
    return value;
  }
  throw new Error(`Unsupported message kind: ${value}`);
}

function toMsgStatus(value: string): MsgStatus {
  if (value === "unread" || value === "read" || value === "done") {
    return value;
  }
  throw new Error(`Unsupported message status: ${value}`);
}

async function mutateBrokerState<T>(
  workspaceDir: string,
  mutator: (store: BrokerState) => Promise<T> | T
): Promise<T> {
  const key = getBrokerStatePath(workspaceDir);
  const previous = brokerWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  brokerWriteQueues.set(key, previous.then(() => current));

  await previous;
  try {
    const store = await readBrokerState(workspaceDir);
    const result = await mutator(store);
    await writeBrokerState(workspaceDir, store);
    return result;
  } finally {
    release();
    if (brokerWriteQueues.get(key) === current) {
      brokerWriteQueues.delete(key);
    }
  }
}

async function replaceFileRobust(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EEXIST") {
      throw error;
    }
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await unlink(destination).catch(() => undefined);
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EEXIST") {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }

  await copyFile(source, destination);
  await unlink(source).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

