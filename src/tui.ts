import {
  isStatusOffer,
  STATUS_MAX_CHARS,
  STATUS_ACTION_MS,
  STATUS_DELIVERY_MS,
  isStatusReceiver,
  statusOutputDefinition,
  statusTargets,
  type StatusLocation,
  type StatusOutput,
  type StatusReceiver,
} from "./v2-status-output";

export type StatusTuiContext = {
  client: {
    rpc(definition: typeof statusOutputDefinition): {
      [Method in "claim" | "acknowledge" | "cancel"]: (
        input: StatusReceiver,
        options?: { location?: StatusLocation; signal?: AbortSignal },
      ) => Promise<unknown>;
    } & {
      events: {
        on(
          name: "offer" | "output" | "release",
          handler: (event: { data: unknown; location?: StatusLocation }) => void | Promise<void>,
          options?: { signal?: AbortSignal },
        ): () => void;
      };
    };
  };
  location?: StatusLocation;
  ui: {
    router: { current(): { type: string; sessionID?: string } };
    dialog: {
      alert(options: { title: string; message: string }): Promise<void>;
      set(options: { size: "large"; centered: boolean }): void;
    };
  };
};

export function receiveStatus(context: StatusTuiContext) {
  const receiverID = crypto.randomUUID();
  const rpc = context.client.rpc(statusOutputDefinition);
  const controller = new AbortController();
  let claim: { requestID: string; sessionID: string; expiresAt: number } | undefined;
  let displaying = false;
  let reservationTimer: ReturnType<typeof setTimeout> | undefined;
  const offs: (() => void)[] = [];
  const dispose = () => {
    if (claim)
      void rpc
        .cancel({ requestID: claim.requestID, sessionID: claim.sessionID, receiverID }, { location: context.location })
        .catch(() => undefined);
    controller.abort();
    clearTimeout(reservationTimer);
    for (const off of offs.splice(0)) off();
    claim = undefined;
    // Dialog has no public ownership handle. Never clear a replacement/unrelated dialog.
  };
  try {
    offs.push(
      rpc.events.on(
        "offer",
        async (event) => {
          const offer = event.data;
          if (
            controller.signal.aborted ||
            displaying ||
            !isStatusOffer(offer) ||
            !statusTargets(offer, event.location, context.location, context.ui.router.current()) ||
            claim
          )
            return;
          claim = offer;
          // Terminal release normally clears this. Bound a lost release/disconnect,
          // independently of the offer TTL; this never closes any dialog.
          clearTimeout(reservationTimer);
          reservationTimer = setTimeout(
            () => {
              if (claim === offer) claim = undefined;
            },
            STATUS_ACTION_MS + 2 * STATUS_DELIVERY_MS,
          );
          try {
            const result = await rpc.claim(
              { requestID: offer.requestID, sessionID: offer.sessionID, receiverID },
              { location: context.location, signal: controller.signal },
            );
            if (!(result as { accepted?: boolean })?.accepted && claim === offer) claim = undefined;
          } catch {
            // A lost RPC response does not prove the server rejected admission.
            // Hold reservation until terminal release or the bounded fallback.
          }
        },
        { signal: controller.signal },
      ),
    );
    offs.push(
      rpc.events.on(
        "output",
        async (event) => {
          const output = event.data as StatusOutput;
          if (
            controller.signal.aborted ||
            displaying ||
            !isStatusOffer(output) ||
            output.receiverID !== receiverID ||
            output.requestID !== claim?.requestID ||
            output.sessionID !== claim.sessionID ||
            typeof output.message !== "string" ||
            output.message.length > STATUS_MAX_CHARS ||
            typeof output.title !== "string" ||
            !output.title.length ||
            output.title.length > 80 ||
            !statusTargets(output, event.location, context.location, context.ui.router.current())
          )
            return;
          claim = undefined;
          clearTimeout(reservationTimer);
          try {
            // The promise ends at dismissal, not rendering; ACK only witnesses the request.
            const dismissed = context.ui.dialog.alert({ title: output.title, message: output.message });
            displaying = true;
            void dismissed
              .catch(() => undefined)
              .finally(() => {
                displaying = false;
              });
            context.ui.dialog.set({ size: "large", centered: true });
            await rpc.acknowledge(
              { requestID: output.requestID, sessionID: output.sessionID, receiverID },
              { location: context.location, signal: controller.signal },
            );
          } catch {
            // Delivery failure never clears an unrelated dialog or enqueues model input.
          }
        },
        { signal: controller.signal },
      ),
    );
    offs.push(
      rpc.events.on(
        "release",
        (event) => {
          const input = event.data;
          if (
            isStatusReceiver(input) &&
            input.receiverID === receiverID &&
            input.requestID === claim?.requestID &&
            input.sessionID === claim.sessionID
          ) {
            claim = undefined;
            clearTimeout(reservationTimer);
          }
        },
        { signal: controller.signal },
      ),
    );
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

export default { id: "opencode-short-term-memory", setup: receiveStatus };
