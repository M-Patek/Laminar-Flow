import type { AgentId } from "../types/agent.ts";
import type { AppSnapshot, UiEventRecord } from "../types/app.ts";
import type { Message } from "../types/message.ts";
import {
  findEventById,
  findHandoffById,
  listFilteredEvents,
  listHandoffMessages,
  type SelectedUiEntry
} from "./inspection.ts";
import { findReportById, type VerificationReportEntry } from "./reports.ts";

const RESET = "\u001B[0m";
const DIM = "\u001B[2m";
const CYAN = "\u001B[36m";
const GREEN = "\u001B[32m";
const YELLOW = "\u001B[33m";
const RED = "\u001B[31m";

export function colorStatus(status: string): string {
  switch (status) {
    case "running":
      return `${GREEN}${status}${RESET}`;
    case "waiting_handoff":
    case "waiting_message":
      return `${YELLOW}${status}${RESET}`;
    case "needs_human":
    case "error":
      return `${RED}${status}${RESET}`;
    default:
      return `${CYAN}${status}${RESET}`;
  }
}

export function buildFrame(
  snapshot: AppSnapshot,
  uiState: {
    focusedPane: AgentId;
    eventFilter: "all" | UiEventRecord["scope"];
    eventPage: number;
    showHandoffDetails: boolean;
    inputMode: "direct" | "command";
    drafts: Record<AgentId, string>;
    commandBuffer: string;
    reports: VerificationReportEntry[];
    selectedEvent?: SelectedUiEntry;
    selectedHandoff?: SelectedUiEntry;
    selectedReport?: SelectedUiEntry;
  },
  notice: string,
  columns: number,
  rows: number
): string {
  const safeColumns = Math.max(columns, 80);
  const safeRows = Math.max(rows, 24);
  const paneWidth = Math.floor((safeColumns - 3) / 2);
  const footer = renderFooter(snapshot, uiState, safeColumns - 2);
  const noticeLines = wrap(`Notice: ${notice || "(none)"}`, safeColumns - 2);
  const inputLines = wrap(renderInputLine(uiState), safeColumns - 2);
  const coordinatorHeight = safeRows >= 34 ? 7 : 6;
  const eventHeight = safeRows >= 30 ? 5 : 4;
  const eventDetailHeight = uiState.selectedEvent ? (safeRows >= 34 ? 5 : 4) : 0;
  const handoffHeight = uiState.showHandoffDetails ? (safeRows >= 34 ? 5 : 4) : 0;
  const reportHeight = uiState.selectedReport ? (safeRows >= 34 ? 5 : 4) : 0;
  const reservedRows =
    5 +
    coordinatorHeight +
    eventHeight +
    eventDetailHeight +
    handoffHeight +
    reportHeight +
    footer.length +
    noticeLines.length +
    inputLines.length;
  const paneHeight = Math.max(8, safeRows - reservedRows);
  const left = renderPane(snapshot, "left", paneWidth, paneHeight, uiState);
  const right = renderPane(snapshot, "right", paneWidth, paneHeight, uiState);
  const coordinator = renderCoordinatorPanel(snapshot, safeColumns - 2, coordinatorHeight);
  const events = renderEventFeed(snapshot, safeColumns - 2, eventHeight, uiState.eventFilter, uiState.eventPage);
  const eventDetails = uiState.selectedEvent
    ? renderEventDetails(snapshot, safeColumns - 2, eventDetailHeight, uiState.selectedEvent)
    : [];
  const handoffDetails = uiState.showHandoffDetails
    ? renderHandoffDetails(snapshot, safeColumns - 2, handoffHeight, uiState.selectedHandoff)
    : [];
  const reportDetails = uiState.selectedReport
    ? renderReportDetails(uiState.reports, safeColumns - 2, reportHeight, uiState.selectedReport)
    : [];
  const frame: string[] = [];

  frame.push(paneBorder(paneWidth, paneWidth));
  for (let index = 0; index < paneHeight; index += 1) {
    frame.push(`|${padAnsi(left[index] ?? "", paneWidth)}|${padAnsi(right[index] ?? "", paneWidth)}|`);
  }
  frame.push(paneBorder(paneWidth, paneWidth));
  for (const line of coordinator) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  frame.push(fullBorder(safeColumns - 2));
  for (const line of events) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  frame.push(fullBorder(safeColumns - 2));
  for (const line of eventDetails) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  if (eventDetails.length > 0) {
    frame.push(fullBorder(safeColumns - 2));
  }
  for (const line of handoffDetails) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  if (handoffDetails.length > 0) {
    frame.push(fullBorder(safeColumns - 2));
  }
  for (const line of reportDetails) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  if (reportDetails.length > 0) {
    frame.push(fullBorder(safeColumns - 2));
  }
  for (const line of footer) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  for (const line of noticeLines) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  for (const line of inputLines) {
    frame.push(`|${padAnsi(line, safeColumns - 2)}|`);
  }
  frame.push(`+${"-".repeat(safeColumns - 2)}+`);

  return `\u001B[?25l\u001B[H\u001B[2J${frame.join("\n")}`;
}

function renderPane(
  snapshot: AppSnapshot,
  agentId: AgentId,
  width: number,
  height: number,
  uiState: {
    focusedPane: AgentId;
    inputMode: "direct" | "command";
    drafts: Record<AgentId, string>;
  }
): string[] {
  const agent = snapshot.agents[agentId];
  const counterpart = agentId === "left" ? "right" : "left";
  const underTakeover = snapshot.coordinator.takenOverAgents.includes(agentId);
  const focused = uiState.focusedPane === agentId;
  const draft = uiState.drafts[agentId];
  const draftState = focused && uiState.inputMode === "direct" ? " [direct]" : "";
  const lines: string[] = [];

  lines.push(
    `${agentId.toUpperCase()}${focused ? " | FOCUS" : ""} | ${agent.role} | ${colorStatus(agent.status)} | round ${agent.round} | q ${agent.queuedMessages}${underTakeover ? " | TAKEOVER" : ""}`
  );
  lines.push("-".repeat(width));
  lines.push(`Session: ${formatSession(agent.sessionId, agent.sessionUpdatedAt)}`);
  lines.push(`Intent: ${agent.currentIntent ?? "(none)"}`);
  lines.push(`Draft${draftState}: ${draft || "(empty)"}`);
  lines.push(`Counterpart: ${counterpart}`);
  lines.push(`Last action: ${agent.lastActionAt ?? "(none)"}`);
  if (agent.lastOutputSummary) {
    lines.push(`Last summary: ${agent.lastOutputSummary}`);
  }
  lines.push("-".repeat(width));
  lines.push("Recent transcript:");

  const messages = recentMessagesForAgent(snapshot.recentMessages, agentId, 5);
  if (messages.length === 0) {
    lines.push(`${DIM}(no messages yet)${RESET}`);
  } else {
    for (const message of messages) {
      lines.push(`[${message.kind}] ${message.from} -> ${message.to}: ${message.summary ?? message.body}`);
    }
  }

  if (agent.lastError) {
    lines.push("-".repeat(width));
    lines.push(
      `${RED}${agent.lastErrorKind ? `Issue [${agent.lastErrorKind}]` : "Error"}: ${agent.lastError}${RESET}`
    );
  }

  return fitHeight(lines, width, height);
}

function renderCoordinatorPanel(snapshot: AppSnapshot, width: number, height: number): string[] {
  const coordinator = snapshot.coordinator;
  const takeover = coordinator.takenOverAgents.length > 0 ? coordinator.takenOverAgents.join(", ") : "(none)";
  const maxTurns = coordinator.maxTurns > 0 ? coordinator.maxTurns : "unlimited";
  const lines: string[] = [
    `Coordinator | mode ${coordinator.mode} | status ${coordinator.status} | active ${coordinator.activeAgent ?? "(none)"} | handoffs ${coordinator.handoffCount}`,
    `Takeover: ${takeover} | Turns: ${coordinator.turnCount}/${maxTurns}`,
    `Decision: ${coordinator.lastDecision ?? "(none)"}`,
    `Last handoff: ${coordinator.lastHandoffFrom && coordinator.lastHandoffTo ? `${coordinator.lastHandoffFrom} -> ${coordinator.lastHandoffTo}` : "(none)"} | Summary: ${coordinator.lastHandoffSummary ?? "(none)"}`,
    `Handoff ask: ${coordinator.lastHandoffAsk ?? "(none)"}`,
    `Handoff risk: ${coordinator.lastHandoffRisk ?? "(none)"}`,
    `Auto streak: ${coordinator.autoTurnStreakAgent ?? "(none)"} x ${coordinator.autoTurnStreakCount ?? 0} | Halt: ${coordinator.haltKind ?? "(none)"} | Reason: ${coordinator.haltReason ?? "(none)"}`
  ];

  return fitHeight(lines, width, height);
}

function renderEventFeed(
  snapshot: AppSnapshot,
  width: number,
  height: number,
  filter: "all" | UiEventRecord["scope"],
  page: number
): string[] {
  const filtered = listFilteredEvents(snapshot, filter);
  const pageSize = Math.max(1, height - 1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = safePage * pageSize;
  const currentSlice = filtered.slice(start, start + pageSize);
  const lines: string[] = [`Event feed | filter ${filter} | page ${safePage + 1}/${pageCount} | newest first`];

  if (currentSlice.length === 0) {
    lines.push(`${DIM}(no matching events)${RESET}`);
  } else {
    for (const [index, event] of currentSlice.entries()) {
      lines.push(`[#${start + index + 1}] [${formatClock(event.at)}] ${event.scope}: ${event.message}`);
    }
  }

  return fitHeight(lines, width, height);
}

function renderEventDetails(
  snapshot: AppSnapshot,
  width: number,
  height: number,
  selection: SelectedUiEntry
): string[] {
  const event = findEventById(snapshot, selection.id);
  const lines: string[] = [`Event detail #${selection.rank}:`];

  if (!event) {
    lines.push(`${DIM}(selected event is no longer available)${RESET}`);
    return fitHeightPreserveStart(lines, width, height);
  }

  lines.push(`At: ${event.at} | Scope: ${event.scope}`);
  lines.push(`Id: ${event.id}`);
  lines.push(`Message: ${event.message}`);
  return fitHeightPreserveStart(lines, width, height);
}

function renderHandoffDetails(
  snapshot: AppSnapshot,
  width: number,
  height: number,
  selection: SelectedUiEntry | undefined
): string[] {
  const latestHandoff = selection ? findHandoffById(snapshot, selection.id) : listHandoffMessages(snapshot)[0];
  const label = selection ? `#${selection.rank}` : "#1";
  const lines: string[] = [`Handoff detail ${label}:`];

  if (!latestHandoff) {
    lines.push(`${DIM}(no handoff recorded yet)${RESET}`);
    return fitHeight(lines, width, height);
  }

  lines.push(`Route: ${latestHandoff.from} -> ${latestHandoff.to} | round ${latestHandoff.round}`);
  lines.push(`Id: ${latestHandoff.id}`);
  lines.push(`Summary: ${latestHandoff.summary ?? "(none)"}`);
  lines.push(`Risk: ${extractSection(latestHandoff.body, "Risk") ?? "(none)"}`);
  lines.push(`Ask: ${extractSection(latestHandoff.body, "Ask") ?? "(none)"}`);
  lines.push(`Body: ${latestHandoff.body}`);
  return fitHeightPreserveStart(lines, width, height);
}

function renderReportDetails(
  reports: VerificationReportEntry[],
  width: number,
  height: number,
  selection: SelectedUiEntry
): string[] {
  const report = findReportById(reports, selection.id);
  const lines: string[] = [`Report detail #${selection.rank}:`];

  if (!report) {
    lines.push(`${DIM}(selected report is no longer available)${RESET}`);
    return fitHeightPreserveStart(lines, width, height);
  }

  lines.push(`File: ${report.name} | Kind: ${report.kind}`);
  lines.push(`Generated: ${report.generatedAt ?? "(unknown)"}`);
  lines.push(`Summary: ${report.summary}`);
  lines.push(`Path: ${report.path}`);
  lines.push(`Body: ${report.raw}`);
  return fitHeightPreserveStart(lines, width, height);
}

function renderFooter(
  snapshot: AppSnapshot,
  uiState: {
    focusedPane: AgentId;
    inputMode: "direct" | "command";
    selectedEvent?: SelectedUiEntry;
    selectedHandoff?: SelectedUiEntry;
    selectedReport?: SelectedUiEntry;
    showHandoffDetails?: boolean;
  },
  width: number
): string[] {
  const coordinator = snapshot.coordinator;
  const line = [
    `mode:${coordinator.mode}`,
    `status:${coordinator.status}`,
    `focus:${uiState.focusedPane}`,
    `input:${uiState.inputMode}${uiState.inputMode === "direct" ? `:${uiState.focusedPane}` : ""}`,
    `turns:${coordinator.turnCount}/${coordinator.maxTurns > 0 ? coordinator.maxTurns : "inf"}`,
    coordinator.takenOverAgents.length > 0 ? `takeover:${coordinator.takenOverAgents.join(",")}` : null,
    uiState.selectedEvent ? `event:#${uiState.selectedEvent.rank}` : null,
    uiState.showHandoffDetails ? `handoff:${uiState.selectedHandoff ? `#${uiState.selectedHandoff.rank}` : "#1"}` : null,
    uiState.selectedReport ? `report:#${uiState.selectedReport.rank}` : null,
    `handoffs:${coordinator.handoffCount}`,
    coordinator.haltKind ? `haltKind:${coordinator.haltKind}` : null,
    coordinator.haltReason ? `halt:${coordinator.haltReason}` : null,
    coordinator.lastDecision ? `decision:${coordinator.lastDecision}` : null
  ]
    .filter(Boolean)
    .join(" | ");

  return wrap(line, width);
}

function renderInputLine(uiState: {
  focusedPane: AgentId;
  inputMode: "direct" | "command";
  drafts: Record<AgentId, string>;
  commandBuffer: string;
}): string {
  if (uiState.inputMode === "command") {
    return `command> ${uiState.commandBuffer}`;
  }

  return `${uiState.focusedPane}> ${uiState.drafts[uiState.focusedPane]}`;
}

function paneBorder(leftWidth: number, rightWidth: number): string {
  return `+${"-".repeat(leftWidth)}+${"-".repeat(rightWidth)}+`;
}

function fullBorder(width: number): string {
  return `+${"-".repeat(width)}+`;
}

function fitHeight(lines: string[], width: number, height: number): string[] {
  const normalized = lines.flatMap((line) => wrap(line, width));
  if (normalized.length >= height) {
    return normalized.slice(normalized.length - height);
  }

  return [...normalized, ...Array.from({ length: height - normalized.length }, () => "")];
}

function fitHeightPreserveStart(lines: string[], width: number, height: number): string[] {
  const normalized = lines.flatMap((line) => wrap(line, width));
  if (normalized.length <= height) {
    return [...normalized, ...Array.from({ length: height - normalized.length }, () => "")];
  }

  if (height === 1) {
    return [normalized[0].slice(0, Math.max(0, width - 3)) + "..."];
  }

  return [...normalized.slice(0, height - 1), "..."];
}

function recentMessagesForAgent(messages: Message[], agentId: AgentId, limit: number): Message[] {
  return messages
    .filter((message) => message.from === agentId || message.to === agentId)
    .slice(-limit);
}

function formatSession(sessionId: string | undefined, updatedAt: string | undefined): string {
  if (!sessionId) {
    return "(none)";
  }

  const shortId = sessionId.slice(0, 8);
  const stamp = updatedAt ? formatClock(updatedAt) : "unknown";
  return `${shortId} @ ${stamp}`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function wrap(text: string, width: number): string[] {
  const plain = text.replace(/\r/g, "");
  const rawLines = plain.split("\n");
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine) {
      wrapped.push("");
      continue;
    }

    let cursor = 0;
    while (cursor < rawLine.length) {
      wrapped.push(rawLine.slice(cursor, cursor + width));
      cursor += width;
    }
  }

  return wrapped.length > 0 ? wrapped : [""];
}

function padAnsi(value: string, width: number): string {
  const visible = stripAnsi(value);
  if (visible.length >= width) {
    return value.slice(0, width);
  }

  return `${value}${" ".repeat(width - visible.length)}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function extractSection(body: string, label: string): string | undefined {
  const match = body.match(new RegExp(`${label}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][a-z]+:|$)`));
  return match?.[1]?.replace(/\s+/g, " ").trim();
}
