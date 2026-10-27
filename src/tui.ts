import {
  isStatusOffer,
  STATUS_MAX_CHARS,
  STATUS_ACTION_MS,
  STATUS_DELIVERY_MS,
  isStatusReceiver,
  statusOutputDefinition,
  statusTargets,
  type StatusActionRequest,
  type StatusLocation,
  type StatusOutput,
  type StatusReceiver,
} from "./v2-status-output";
import { loadReaderRuntime, renderV2TextReader, type ReaderRuntime, type V2ReaderHost } from "./v2-text-reader";
import { setupV1Tui } from "./v1-tui";
import { registerV2TuiMenu } from "./v2-tui-menu";
export { setupV1Tui, type V1TuiContext } from "./v1-tui";

export type StatusTuiContext = Pick<V2ReaderHost, "renderer" | "keymap"> & {
  client: {
    rpc(definition: typeof statusOutputDefinition): StatusRpcClient;
  };
  location?: StatusLocation;
  ui: {
    router: { current(): { type: string; sessionID?: string } };
    dialog: {
      select<Value>(options: {
        title: string;
        options: readonly { readonly title: string; readonly value: Value }[];
      }): Promise<Value | undefined>;
      confirm(options: {
        title: string;
        message: string;
        label?: { confirm?: string; cancel?: string };
      }): Promise<boolean | undefined>;
      alert(options: { title: string; message: string }): Promise<void>;
      show(render: () => any, onClose?: () => void): void;
      set(options: { size: "large"; centered: boolean }): void;
    };
  };
};

type StatusRpcClient = {
  action: (
    input: StatusActionRequest,
    options?: { location?: StatusLocation; signal?: AbortSignal },
  ) => Promise<unknown>;
  claim: (input: StatusReceiver, options?: { location?: StatusLocation; signal?: AbortSignal }) => Promise<unknown>;
  acknowledge: (
    input: StatusReceiver,
    options?: { location?: StatusLocation; signal?: AbortSignal },
  ) => Promise<unknown>;
  cancel: (input: StatusReceiver, options?: { location?: StatusLocation; signal?: AbortSignal }) => Promise<unknown>;
  events: {
    on(
      name: "offer" | "output" | "release",
      handler: (event: { data: unknown; location?: StatusLocation }) => void | Promise<void>,
      options?: { signal?: AbortSignal },
    ): () => void;
  };
};

export function receiveStatus(context: StatusTuiContext, options: { loadRuntime?: () => Promise<ReaderRuntime> } = {}) {
  const receiverID = crypto.randomUUID();
  const rpc = context.client.rpc(statusOutputDefinition);
  const controller = new AbortController();
  let claim: { requestID: string; sessionID: string; expiresAt: number } | undefined;
  let display: object | undefined;
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
    registerV2TuiMenu(context, rpc.action, controller.signal);
    offs.push(
      rpc.events.on(
        "offer",
        async (event) => {
          const offer = event.data;
          if (
            controller.signal.aborted ||
            display ||
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
            display ||
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
          const owner = {};
          display = owner;
          let closed = false;
          const abandon = () => {
            closed = true;
            if (display === owner) display = undefined;
          };
          try {
            let loadTimer: ReturnType<typeof setTimeout> | undefined;
            const runtime = await Promise.race([
              (options.loadRuntime ?? loadReaderRuntime)(),
              new Promise<never>((_, reject) => {
                loadTimer = setTimeout(
                  () => reject(new Error("STM reader runtime load expired")),
                  Math.max(1, output.expiresAt - Date.now()),
                );
              }),
            ]).finally(() => clearTimeout(loadTimer));
            // Runtime loading can outlive the output deadline or a route change.
            const current = () =>
              !controller.signal.aborted &&
              statusTargets(
                { ...output, expiresAt: Number.MAX_SAFE_INTEGER },
                event.location,
                context.location,
                context.ui.router.current(),
              );
            if (!current() || output.expiresAt <= Date.now()) {
              abandon();
              return;
            }
            let ready!: () => void;
            const rendered = new Promise<void>((resolve) => {
              ready = resolve;
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const unavailable = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  closed = true;
                  reject(new Error("STM dialog did not render before delivery expired"));
                },
                Math.max(1, output.expiresAt - Date.now()),
              );
            });
            try {
              context.ui.dialog.show(
                () => {
                  if (closed || !current()) {
                    abandon();
                    ready();
                    return null;
                  }
                  return renderV2TextReader(
                    context,
                    runtime,
                    output.title,
                    output.message,
                    () => !closed && current(),
                    ready,
                  );
                },
                () => {
                  abandon();
                  ready();
                },
              );
              context.ui.dialog.set({ size: "large", centered: true });
              await Promise.race([rendered, unavailable]);
              if (closed || !current() || output.expiresAt <= Date.now()) {
                abandon();
                return;
              }
              await rpc.acknowledge(
                { requestID: output.requestID, sessionID: output.sessionID, receiverID },
                { location: context.location, signal: controller.signal },
              );
            } finally {
              clearTimeout(timer);
            }
          } catch {
            abandon();
            // A render failure is not acknowledged; server delivery expires honestly.
            // Never clear a replacement/unrelated dialog or enqueue model input.
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

// The V1 loader selects tui(); the V2 loader selects setup(). Both entrypoints
// remain native; V2 renders custom results with the host-owned UI runtime.
export default { id: "opencode-short-term-memory", setup: receiveStatus, tui: setupV1Tui };
