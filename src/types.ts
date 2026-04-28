import type { PluginInput, Config as OpencodeConfig, ToolContext } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";

export type Client = PluginInput["client"];
export type { OpencodeConfig, ToolContext };

// Runtime hooks not yet fully typed by the SDK @opencode-ai/plugin
export interface SessionCreatedInput {
  sessionID?: string;
  event?: {
    properties?: {
      info?: {
        parentID?: string;
      };
    };
  };
}

export interface SessionUpdatedInput {
  sessionID?: string;
}

export interface SessionDeletedInput {
  sessionID?: string;
}

export interface EventInput {
  event?: unknown;
  sessionID?: string;
}

export interface MessageUpdatedInput {
  sessionID?: string;
  message?: {
    role?: string;
    content?: string;
    parts?: unknown[];
  };
  parts?: unknown[];
}

export interface ChatMessageInput {
  sessionID?: string;
  message?: {
    role?: string;
  };
}

export interface ChatMessageOutput {
  message?: {
    content?: string;
  };
  parts?: Part[];
}

export interface SystemTransformInput {
  sessionID?: string;
  messageID?: string;
  message?: {
    id?: string;
  };
  id?: string;
}

export interface SystemTransformOutput {
  system: string[];
}

export interface CompactionInput {
  sessionID?: string;
}

// SDK type: { context: string[]; prompt?: string }
export interface CompactionOutput {
  context: string[];
  prompt?: string;
}

// SDK base: { command: string; sessionID: string; arguments: string }
// Runtime may pass richer shapes, so we type permissively.
export interface CommandExecuteBeforeInput {
  command?: {
    name?: string;
    argument?: string;
  };
  name?: string;
  args?: {
    name?: string;
    argument?: string;
    value?: string;
  };
  argument?: string;
  sessionID?: string;
  ctx?: unknown;
}

// SDK base: { parts: Part[] }
// Runtime also accepts stop / message for command interception.
export interface CommandExecuteBeforeOutput {
  parts?: Part[];
  stop?: boolean;
  message?: string;
}
