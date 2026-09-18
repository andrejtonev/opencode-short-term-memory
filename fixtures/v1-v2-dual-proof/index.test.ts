import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import fixture from "./index";

describe("V1/V2 dual-runtime module shape", () => {
  test("exports one object and registers only the verified V2 surfaces", async () => {
    const registrations: string[] = [];
    let toolID: string | undefined;
    let locationReads = 0;
    const location = {};
    const context = {
      get location() {
        locationReads += 1;
        return location;
      },
      session: {
        async hook(name: string) {
          registrations.push(`session:${name}`);
          return { async dispose() {} };
        },
      },
      tool: {
        async transform(callback: (editor: { add(tool: { name: string }): void }) => void) {
          registrations.push("tool:transform");
          callback({
            add(tool) {
              toolID = tool.name;
            },
          });
          return { async dispose() {} };
        },
      },
    } as unknown as Plugin.Context;

    expect(Object.keys(fixture).sort()).toEqual(["id", "server", "setup"]);
    expect(await fixture.server()).toEqual({});

    await fixture.setup(context);

    expect(locationReads).toBe(1);
    expect(registrations).toEqual(["session:context", "tool:transform"]);
    expect(toolID).toBe("stm_v2_proof");
  });
});
