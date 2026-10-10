import type { PluginInput, Config as OpencodeConfig, ToolContext } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";

export type Client = PluginInput["client"];
export type { OpencodeConfig, ToolContext };

export interface UserExecutionMetadata {
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  tools?: Record<string, boolean>;
}

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
    id?: string;
    messageID?: string;
    parentID?: string;
    parentId?: string;
    parent?: { id?: string; messageID?: string };
    role?: string;
    content?: string;
    parts?: unknown[];
  };
  parts?: unknown[];
}

export interface ChatMessageInput {
  sessionID?: string;
  messageID?: string;
  messageId?: string;
  id?: string;
  agent?: string;
  model?: UserExecutionMetadata["model"];
  tools?: UserExecutionMetadata["tools"];
  message?: {
    id?: string;
    role?: string;
    content?: string;
    parts?: unknown[];
    agent?: string;
    model?: UserExecutionMetadata["model"];
    tools?: UserExecutionMetadata["tools"];
  };
  parts?: unknown[];
}

export interface ChatMessageOutput {
  messageID?: string;
  messageId?: string;
  id?: string;
  agent?: string;
  model?: UserExecutionMetadata["model"];
  tools?: UserExecutionMetadata["tools"];
  message?: {
    id?: string;
    role?: string;
    content?: string;
    parts?: unknown[];
    agent?: string;
    model?: UserExecutionMetadata["model"];
    tools?: UserExecutionMetadata["tools"];
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

export interface CommandExecuteBeforeInput {
  command: string;
  sessionID: string;
  arguments: string;
}

export interface CommandExecuteBeforeOutput {
  parts: Part[];
}
