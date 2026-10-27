import type { Rpc } from "@opencode/plugin/rpc";

export const STATUS_DELIVERY_MS = 3_000;
export const STATUS_ACTION_MS = 120_000;
export const STATUS_MAX_CHARS = 16_384;

const string = { type: "string", minLength: 1 } as const;
const identity = { requestID: string, sessionID: string };
const actionInput = {
  type: "object",
  properties: {
    // Native V2 rejects regex patterns in portable RPC schemas. The action
    // parser still validates path-safe IDs before admission or persistence.
    requestID: { type: "string", minLength: 1, maxLength: 128 },
    sessionID: string,
    action: { type: "string", enum: ["show", "status", "logs", "update", "reset", "settings", "setup"] },
    confirm: { type: "boolean" },
  },
  required: ["requestID", "sessionID", "action"],
  additionalProperties: false,
} as const;
const receiver = {
  type: "object",
  properties: { ...identity, receiverID: string },
  required: ["requestID", "sessionID", "receiverID"],
  additionalProperties: false,
} as const;
const accepted = {
  type: "object",
  properties: { accepted: { type: "boolean" } },
  required: ["accepted"],
  additionalProperties: false,
} as const;

// Portable schemas keep the UI entry free of server code and runtime schema dependencies.
export const statusOutputDefinition = {
  id: "stm.status-output",
  methods: {
    action: { input: actionInput, output: accepted },
    claim: { input: receiver, output: accepted },
    acknowledge: { input: receiver, output: accepted },
    cancel: { input: receiver, output: accepted },
  },
  events: {
    release: { schema: receiver },
    offer: {
      schema: {
        type: "object",
        properties: { ...identity, expiresAt: { type: "number" } },
        required: ["requestID", "sessionID", "expiresAt"],
        additionalProperties: false,
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ...receiver.properties,
          expiresAt: { type: "number" },
          message: { type: "string", maxLength: STATUS_MAX_CHARS },
          title: { type: "string", minLength: 1, maxLength: 80 },
        },
        required: [...receiver.required, "expiresAt", "message", "title"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type StatusReceiver = { requestID: string; sessionID: string; receiverID: string };
export type StatusActionRequest = {
  requestID: string;
  sessionID: string;
  action: "show" | "status" | "logs" | "update" | "reset" | "settings" | "setup";
  confirm?: boolean;
};
export type StatusOffer = { requestID: string; sessionID: string; expiresAt: number };
export type StatusOutput = StatusOffer & { receiverID: string; message: string; title: string };
export type StatusLocation = { directory: string; workspaceID?: string };

export function isStatusReceiver(value: unknown): value is StatusReceiver {
  if (!value || typeof value !== "object") return false;
  const input = value as StatusReceiver;
  return [input.requestID, input.sessionID, input.receiverID].every(
    (item) => typeof item === "string" && item.length > 0,
  );
}

export function isStatusOffer(value: unknown): value is StatusOffer {
  if (!value || typeof value !== "object") return false;
  const input = value as StatusOffer;
  return (
    typeof input.requestID === "string" &&
    input.requestID.length > 0 &&
    typeof input.sessionID === "string" &&
    input.sessionID.length > 0 &&
    Number.isFinite(input.expiresAt)
  );
}

export function statusTargets(
  offer: StatusOffer,
  eventLocation: StatusLocation | undefined,
  location: StatusLocation | undefined,
  route: { type: string; sessionID?: string },
) {
  return (
    Date.now() < offer.expiresAt &&
    eventLocation !== undefined &&
    location !== undefined &&
    eventLocation.directory === location.directory &&
    eventLocation.workspaceID === location.workspaceID &&
    route.type === "session" &&
    route.sessionID === offer.sessionID
  );
}

export default statusOutputDefinition;
