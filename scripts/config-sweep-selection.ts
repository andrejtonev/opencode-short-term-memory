import { CONFIG_SCENARIO_IDS } from "./rc-config-scenarios";

export function selectConfigSweepCases(selection: readonly string[]): string[] {
  const all = ["v1", "v2"].flatMap((generation) => CONFIG_SCENARIO_IDS.map((id) => `${generation}:${id}`));
  if (new Set(selection).size !== selection.length) throw new Error("Duplicate config sweep selector");
  for (const item of selection) if (!all.includes(item)) throw new Error(`Unknown config sweep selector: ${item}`);
  return selection.length ? [...selection] : all;
}

export function configSweepPassed(
  selected: readonly string[],
  results: readonly { generation: string; id: string; verdict: string }[],
): boolean {
  const completed = results.map((result) => `${result.generation}:${result.id}`);
  return (
    selected.length > 0 &&
    completed.length === selected.length &&
    new Set(completed).size === completed.length &&
    completed.every((key) => selected.includes(key)) &&
    results.every((result) => result.verdict === "PASS")
  );
}
