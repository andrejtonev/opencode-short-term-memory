import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { V2Context, V2RuntimeContract } from "./v2-adapter";
import { createV2MemoryActions } from "./v2-memory-tools";
import { parseV2MemoryCommand, type V2MemoryCommandActions } from "./v2-memory-command";
import {
  isStatusReceiver,
  STATUS_DELIVERY_MS,
  STATUS_ACTION_MS,
  STATUS_MAX_CHARS,
  statusOutputDefinition,
  type StatusOffer,
  type StatusOutput,
  type StatusReceiver,
} from "./v2-status-output";

type Request = ReturnType<typeof parseV2MemoryCommand>;

export function createStatusDelivery(
  emit: (name: "offer" | "output" | "release", data: StatusOffer | StatusOutput | StatusReceiver) => Promise<void>,
  deadlineMs = STATUS_DELIVERY_MS,
  actionMs = STATUS_ACTION_MS,
) {
  let disposed = false;
  let activeAction = false;
  let pending:
    | {
        offer: StatusOffer;
        receiverID?: string;
        phase: "admission" | "action" | "output";
        outputExpiresAt?: number;
        admit: () => void;
        finish: (error?: Error) => void;
      }
    | undefined;
  const matches = (input: unknown) =>
    isStatusReceiver(input) &&
    pending !== undefined &&
    input.requestID === pending.offer.requestID &&
    input.sessionID === pending.offer.sessionID;

  return {
    async deliver(request: Request): Promise<void> {
      if (disposed || pending || activeAction) throw new Error("STM command delivery disposed or busy; retry later.");
      const offer = {
        requestID: crypto.randomUUID(),
        sessionID: request.sessionID,
        expiresAt: Date.now() + deadlineMs,
      };
      let timer: ReturnType<typeof setTimeout>;
      let interval: ReturnType<typeof setInterval>;
      let started = false;
      let settled = false;
      let admit!: () => void;
      const admission = new Promise<void>((resolve) => {
        admit = resolve;
      });
      let finish!: (error?: Error) => void;
      const completion = new Promise<void>((resolve, reject) => {
        finish = (error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
      });
      const current = { offer, phase: "admission" as "admission" | "action" | "output", admit, finish };
      pending = current;
      const failure = (detail: string, cause?: unknown) =>
        new Error(
          `${request.title} ${detail}${started && request.mutating ? " Mutation may have completed; no rollback is implied. Inspect state before retrying." : started ? " Action was started; it will not be rerun." : " No action was run."}`,
          { cause },
        );
      const send = async () => {
        if (pending !== current || current.phase !== "admission" || settled) return;
        try {
          await emit("offer", offer);
        } catch (error) {
          if (pending === current && current.phase === "admission") finish(failure("offer delivery failed.", error));
        }
      };
      timer = setTimeout(
        () =>
          finish(
            failure("not displayed: no connected TUI receiver admitted before deadline (receiver absent or busy)."),
          ),
        deadlineMs,
      );
      interval = setInterval(send, Math.min(100, deadlineMs));
      try {
        void send();
        await Promise.race([admission, completion]);
        if (disposed || settled || pending !== current || !pending.receiverID) throw failure("admission cancelled.");
        clearTimeout(timer);
        clearInterval(interval);
        current.phase = "action";
        started = true;
        activeAction = true;
        timer = setTimeout(() => finish(failure("action completion deadline exceeded.")), actionMs);
        // The command owns this promise; claim RPC only reserves the receiver.
        const action = (async () => {
          try {
            return await request.run();
          } finally {
            activeAction = false;
          }
        })();
        let message: string;
        let title = request.title;
        try {
          const result = await Promise.race([action, completion]);
          if (typeof result !== "string") throw new Error("STM action returned no text output.");
          message = result;
        } catch (error) {
          if (settled || disposed) throw error;
          title += " error";
          message = failure(`action failed: ${error instanceof Error ? error.message : String(error)}`, error).message;
        }
        if (settled || disposed || pending !== current) throw failure("output cancelled.");
        clearTimeout(timer);
        current.phase = "output";
        const suffix = `\n[${request.title} truncated at ${STATUS_MAX_CHARS} characters]`;
        if (message.length > STATUS_MAX_CHARS) message = message.slice(0, STATUS_MAX_CHARS - suffix.length) + suffix;
        const output = {
          ...offer,
          receiverID: pending.receiverID!,
          expiresAt: Date.now() + deadlineMs,
          title,
          message,
        };
        pending.outputExpiresAt = output.expiresAt;
        timer = setTimeout(
          () =>
            finish(
              failure(
                "output not acknowledged before deadline; receiver disconnected, changed route, or failed to display.",
              ),
            ),
          deadlineMs,
        );
        void emit("output", output).catch((error: unknown) => finish(failure("output delivery failed.", error)));
        await completion;
      } finally {
        clearTimeout(timer!);
        clearInterval(interval!);
        if (pending === current) {
          const receiverID = pending.receiverID;
          pending = undefined;
          if (receiverID)
            void emit("release", { requestID: offer.requestID, sessionID: offer.sessionID, receiverID }).catch(
              () => undefined,
            );
        }
      }
    },
    async claim(input: unknown) {
      if (
        !matches(input) ||
        !isStatusReceiver(input) ||
        pending!.phase !== "admission" ||
        pending!.receiverID ||
        Date.now() >= pending!.offer.expiresAt ||
        disposed
      )
        return { accepted: false };
      pending!.receiverID = input.receiverID;
      pending!.admit();
      return { accepted: true };
    },
    acknowledge(input: unknown) {
      if (
        !matches(input) ||
        !isStatusReceiver(input) ||
        pending!.phase !== "output" ||
        Date.now() >= (pending!.outputExpiresAt ?? 0) ||
        pending!.receiverID !== input.receiverID
      )
        return { accepted: false };
      pending!.finish();
      return { accepted: true };
    },
    cancel(input: unknown) {
      if (!matches(input) || !isStatusReceiver(input) || pending!.receiverID !== input.receiverID)
        return { accepted: false };
      const started = pending!.phase !== "admission";
      pending!.finish(
        new Error(
          `STM receiver cancelled. ${started ? "Action may have completed; no rollback is implied. Inspect state before retrying." : "No action was run."}`,
        ),
      );
      return { accepted: true };
    },
    dispose() {
      disposed = true;
      pending?.finish(
        new Error(
          `STM command delivery disposed. ${pending?.phase === "admission" ? "No action was run." : "Action may have completed; no rollback is implied. Inspect state before retrying."}`,
        ),
      );
    },
  };
}

export function createStatusCommand(actions: V2MemoryCommandActions, deliver: (request: Request) => Promise<void>) {
  return {
    name: "stm",
    description:
      "Short-term memory: status (default), show, logs, settings, update, setup confirm true, reset confirm true.",
    async execute(input) {
      await deliver(parseV2MemoryCommand(input, actions));
    },
  } satisfies CommandDefinition;
}

export async function setupStatusCommand(context: V2Context, runtime: V2RuntimeContract) {
  const delivery = createStatusDelivery((name, data) => registration.events.emit(name, data));
  const registration = await context.rpc.register(statusOutputDefinition, {
    claim: (input) => delivery.claim(input),
    acknowledge: async (input) => delivery.acknowledge(input),
    cancel: async (input) => delivery.cancel(input),
  });
  try {
    await runtime.registerCommand({
      name: "stm",
      definition: createStatusCommand(createV2MemoryActions(context), delivery.deliver),
    });
  } catch (error) {
    delivery.dispose();
    try {
      await registration.dispose();
    } catch {}
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return () => {
    delivery.dispose();
    return (disposal ??= registration.dispose());
  };
}
