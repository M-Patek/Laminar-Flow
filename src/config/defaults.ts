import type { AppSnapshot } from "../types/app.ts";
import { DEFAULT_ROLES } from "./roles.ts";

export const DUPLEX_DIR = ".duplex";
export const EVENT_LOG_FILE = "events.jsonl";
export const SNAPSHOT_FILE = "session.json";
export const MAX_RECENT_MESSAGES = 40;
export const MAX_RECENT_EVENTS = 24;
export const MAX_AUTO_HANDOFFS = 6;
export const MAX_CONSECUTIVE_AUTO_TURNS = 2;
export const DEFAULT_MAX_TURNS = 8;

export function createDefaultSnapshot(): AppSnapshot {
  const now = new Date().toISOString();

  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    agents: {
      left: {
        id: "left",
        role: DEFAULT_ROLES.left,
        status: "idle",
        round: 0,
        queuedMessages: 0
      },
      right: {
        id: "right",
        role: DEFAULT_ROLES.right,
        status: "idle",
        round: 0,
        queuedMessages: 0
      }
    },
    coordinator: {
      mode: "manual",
      status: "active",
      takenOverAgents: [],
      turnCount: 0,
      maxTurns: DEFAULT_MAX_TURNS,
      handoffCount: 0,
      repetitionCount: 0,
      autoTurnStreakCount: 0,
      lastDecision: "Bootstrapped workspace.",
      haltKind: undefined
    },
    recentMessages: [],
    recentEvents: []
  };
}
