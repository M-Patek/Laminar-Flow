import type { AppSnapshot, UiEventRecord, UiEventScope } from "../types/app.ts";
import type { Message } from "../types/message.ts";

export interface SelectedUiEntry {
  id: string;
  rank: number;
}

export function listFilteredEvents(
  snapshot: Pick<AppSnapshot, "recentEvents">,
  filter: "all" | UiEventScope
): UiEventRecord[] {
  const events =
    filter === "all"
      ? snapshot.recentEvents
      : snapshot.recentEvents.filter((event) => event.scope === filter);

  return [...events].reverse();
}

export function selectEventByRank(
  snapshot: Pick<AppSnapshot, "recentEvents">,
  filter: "all" | UiEventScope,
  rank: number
): SelectedUiEntry | undefined {
  if (rank < 1) {
    return undefined;
  }

  const event = listFilteredEvents(snapshot, filter)[rank - 1];
  return event ? { id: event.id, rank } : undefined;
}

export function selectEventByOffset(
  snapshot: Pick<AppSnapshot, "recentEvents">,
  filter: "all" | UiEventScope,
  currentRank: number,
  offset: number
): SelectedUiEntry | undefined {
  return selectEventByRank(snapshot, filter, currentRank + offset);
}

export function findEventById(
  snapshot: Pick<AppSnapshot, "recentEvents">,
  eventId: string | undefined
): UiEventRecord | undefined {
  if (!eventId) {
    return undefined;
  }

  return snapshot.recentEvents.find((event) => event.id === eventId);
}

export function listHandoffMessages(
  snapshot: Pick<AppSnapshot, "recentMessages">
): Message[] {
  return snapshot.recentMessages.filter((message) => message.kind === "handoff").slice().reverse();
}

export function selectHandoffByRank(
  snapshot: Pick<AppSnapshot, "recentMessages">,
  rank: number
): SelectedUiEntry | undefined {
  if (rank < 1) {
    return undefined;
  }

  const message = listHandoffMessages(snapshot)[rank - 1];
  return message ? { id: message.id, rank } : undefined;
}

export function selectHandoffByOffset(
  snapshot: Pick<AppSnapshot, "recentMessages">,
  currentRank: number,
  offset: number
): SelectedUiEntry | undefined {
  return selectHandoffByRank(snapshot, currentRank + offset);
}

export function findHandoffById(
  snapshot: Pick<AppSnapshot, "recentMessages">,
  messageId: string | undefined
): Message | undefined {
  if (!messageId) {
    return undefined;
  }

  return snapshot.recentMessages.find((message) => message.id === messageId && message.kind === "handoff");
}
