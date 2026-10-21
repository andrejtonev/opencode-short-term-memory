import { appendFileSync } from "node:fs";

// Diagnostic only: runs beside the packaged receiver in an isolated TUI.
// Records event routing and RPC outcomes, never provider credentials.
export default {
  id: "stm-receiver-probe",
  async setup(context: any) {
    const log = (record: any) =>
      appendFileSync(context.options.log, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n");
    log({ event: "setup", location: context.location, route: context.ui.router.current() });
    const original = (await import(context.options.entry)).default;
    const diagnostic = {
      ...context,
      get location() {
        return context.location;
      },
      client: {
        rpc(definition: any) {
          const rpc = context.client.rpc(definition);
          const wrapped: any = { ...rpc };
          for (const name of ["claim", "acknowledge", "cancel"]) {
            wrapped[name] = async (input: any, options: any) => {
              try {
                const result = await rpc[name](input, options);
                log({ event: name, input, location: options?.location, result });
                return result;
              } catch (error) {
                log({ event: name, error: String(error) });
                throw error;
              }
            };
          }
          wrapped.events = {
            ...rpc.events,
            on(name: string, handler: any, options: any) {
              return rpc.events.on(
                name,
                (event: any) => {
                  log({ event: name, payload: event, location: context.location, route: context.ui.router.current() });
                  return handler(event);
                },
                options,
              );
            },
          };
          return wrapped;
        },
      },
    };
    return original.setup(diagnostic);
  },
};
