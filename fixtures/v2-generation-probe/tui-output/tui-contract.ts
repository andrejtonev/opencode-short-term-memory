import type { Context } from "@opencode/plugin/tui/context";
import type { StatusTuiContext, receiveStatus } from "../../../src/tui";

type Assert<T extends true> = T;

export type HostContextContract = Assert<Context extends StatusTuiContext ? true : false>;
export type HostReceiverContract = Assert<typeof receiveStatus extends (context: Context) => () => void ? true : false>;
