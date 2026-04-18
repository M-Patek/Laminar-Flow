import type { AgentId, AgentSessionState } from "./agent.ts";
import type { CoordinatorHaltKind, CoordinatorState } from "./coordinator.ts";
import type { Message } from "./message.ts";

export interface UiEventRecord {
  id: string;
  at: string;
  scope: "system" | "agent" | "coordinator" | "message";
  message: string;
}

export type UiEventScope = UiEventRecord["scope"];

export type AppEvent =
  | {
      type: "message.created";
      payload: Message;
    }
  | {
      type: "agent.status_changed";
      payload: {
        agentId: AgentId;
        from: string;
        to: string;
      };
    }
  | {
      type: "agent.run_started";
      payload: {
        agentId: AgentId;
        round: number;
      };
    }
  | {
      type: "agent.run_completed";
      payload: {
        agentId: AgentId;
        round: number;
        output: string;
      };
    }
  | {
      type: "handoff.created";
      payload: {
        from: AgentId;
        to: AgentId;
        messageId: string;
      };
    }
  | {
      type: "coordinator.mode_changed";
      payload: {
        from: string;
        to: string;
      };
    }
  | {
      type: "coordinator.halted";
      payload: {
        kind?: CoordinatorHaltKind;
        reason: string;
      };
    }
  | {
      type: "system.error";
      payload: {
        scope: string;
        message: string;
      };
    };

export interface AppSnapshot {
  version: number;
  createdAt: string;
  updatedAt: string;
  agents: Record<AgentId, AgentSessionState>;
  coordinator: CoordinatorState;
  recentMessages: Message[];
  recentEvents: UiEventRecord[];
}
