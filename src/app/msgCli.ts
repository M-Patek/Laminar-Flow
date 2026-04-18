import {
  createConfiguredBrokerClient,
  createLocalBrokerClient,
  createMessage,
  listMessages
} from "./brokerClient.ts";
import type { DuplexMessage, MsgStatus } from "./brokerClient.ts";

export { createMessage, createLocalBrokerClient, listMessages } from "./brokerClient.ts";

export type MsgAction = "send" | "inbox" | "read" | "done" | "help";

export function resolveMsgAction(argv: string[]): MsgAction {
  const [command] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return "help";
  }

  if (command === "send" || command === "inbox" || command === "read" || command === "done") {
    return command;
  }

  throw new Error(`Unknown duplex-msg command: ${command}`);
}

export async function runMsgCli(argv: string[], workspaceDir = process.cwd()): Promise<number> {
  const broker = createConfiguredBrokerClient(workspaceDir);
  const action = resolveMsgAction(argv);
  switch (action) {
    case "help":
      process.stdout.write(`${buildMsgHelpText()}\n`);
      return 0;
    case "send": {
      const created = await broker.createMessage(parseSendArgs(argv.slice(1)));
      process.stdout.write(`${formatSendResult(created)}\n`);
      return 0;
    }
    case "inbox": {
      const query = parseInboxArgs(argv.slice(1));
      const messages = await broker.listMessages(query);
      process.stdout.write(`${formatInbox(messages)}\n`);
      return 0;
    }
    case "read": {
      const { id } = parseReadArgs(argv.slice(1));
      const message = await broker.markMessageRead(id);
      process.stdout.write(`${formatReadResult(message)}\n`);
      return 0;
    }
    case "done": {
      const { id } = parseReadArgs(argv.slice(1));
      const message = await broker.markMessageDone(id);
      process.stdout.write(`${formatDoneResult(message)}\n`);
      return 0;
    }
  }
}

export function buildMsgHelpText(): string {
  return [
    "duplex-msg",
    "",
    "Usage:",
    "  duplex-msg send --from left --to right --summary \"review parser\" --ask \"review empty-input\" [--kind handoff] [--ref src/foo.ts]",
    "  duplex-msg inbox [--to left|right] [--from left|right] [--status unread|read|done]",
    "  duplex-msg read <id>",
    "  duplex-msg done <id>",
    "  duplex-msg help",
    "",
    "Notes:",
    "  - Messages are brokered locally under .duplex/broker/state.json",
    "  - DUPLEX_BROKER_TRANSPORT=local|daemon (daemon is currently a stub)",
    "  - Keep messages short and selective; do not dump the full transcript"
  ].join("\n");
}

function parseSendArgs(args: string[]): {
  from: string;
  to: string;
  kind?: string;
  summary: string;
  ask: string;
  refs: string[];
} {
  const values = parseFlags(args);
  const refs = values.ref ? [values.ref].flat() : [];
  return {
    from: readRequiredFlag(values, "from"),
    to: readRequiredFlag(values, "to"),
    kind: firstValue(values.kind),
    summary: readRequiredFlag(values, "summary"),
    ask: readRequiredFlag(values, "ask"),
    refs
  };
}

function parseInboxArgs(args: string[]): { to?: string; from?: string; status?: MsgStatus } {
  const values = parseFlags(args);
  const status = firstValue(values.status);
  return {
    to: firstValue(values.to),
    from: firstValue(values.from),
    status: status ? toMsgStatus(status) : undefined
  };
}

function parseReadArgs(args: string[]): { id: string } {
  const [id] = args;
  if (!id) {
    throw new Error("A message id is required.");
  }
  return { id };
}

function parseFlags(args: string[]): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    const existing = values[key];
    if (existing === undefined) {
      values[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      values[key] = [existing, value];
    }

    index += 1;
  }
  return values;
}

function readRequiredFlag(values: Record<string, string | string[]>, key: string): string {
  const value = firstValue(values[key]);
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toMsgStatus(value: string): MsgStatus {
  if (value === "unread" || value === "read" || value === "done") {
    return value;
  }
  throw new Error(`Unsupported message status: ${value}`);
}

function formatSendResult(message: DuplexMessage): string {
  return `sent ${message.id} ${message.from}->${message.to} [${message.kind}] ${message.summary} | ask:${message.ask}`;
}

function formatInbox(messages: DuplexMessage[]): string {
  if (messages.length === 0) {
    return "(empty inbox)";
  }

  return messages
    .map((message, index) => {
      const refs = message.refs.length > 0 ? ` refs:${message.refs.join(",")}` : "";
      return `${index + 1}. ${message.id} [${message.status}] ${message.from}->${message.to} [${message.kind}] ${message.summary} | ask:${message.ask}${refs}`;
    })
    .join("\n");
}

function formatReadResult(message: DuplexMessage): string {
  const refs = message.refs.length > 0 ? message.refs.join(", ") : "(none)";
  return [
    `${message.id} [${message.status}] ${message.from}->${message.to} [${message.kind}]`,
    `summary: ${message.summary}`,
    `ask: ${message.ask}`,
    `refs: ${refs}`
  ].join("\n");
}

function formatDoneResult(message: DuplexMessage): string {
  return `done ${message.id} ${message.from}->${message.to} [${message.kind}] ${message.summary}`;
}
