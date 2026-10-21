import { expect, test } from "bun:test";
import { keyboardRequestsByTurn } from "../scripts/keyboard-turn-requests";

test("keyboard cadence selects each typed turn and keeps tool continuations in that turn", () => {
  const first = { role: "user", content: "first typed turn" };
  const second = { role: "user", content: "second typed turn" };
  const memory = { role: "user", content: "[MEMORY_SYSTEM]\nretained memory" };
  const requests = [
    { index: 8, messages: [first] },
    { index: 9, summary: true, messages: [first] },
    { index: 11, messages: [first, second, memory] },
    { index: 12, messages: [first, second, memory, { role: "tool", content: "read result" }] },
    {
      index: 14,
      messages: [first, second, memory, { role: "user", content: [{ type: "text", text: "caf\u00e9 \u6771\u4eac" }] }],
    },
  ];
  expect(
    keyboardRequestsByTurn(requests, ["first typed turn", "second typed turn", "caf\u00e9 \u6771\u4eac"]).map((group) =>
      group.map((request) => request.index),
    ),
  ).toEqual([[8], [11, 12], [14]]);
  expect(keyboardRequestsByTurn(requests, ["missing typed turn"])).toEqual([[]]);
});
