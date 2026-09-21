import type { PluginInput } from "@opencode-ai/plugin";
import {
  createV1RuntimeContract,
  type V1RegistrationCollector as ProductionV1RegistrationCollector,
  type V1RuntimeContract,
} from "../src/v1-adapter";

export type V1RegistrationCollector = ProductionV1RegistrationCollector;
export type V1RuntimeContractFixture = V1RuntimeContract;

export function createV1RuntimeContractFixture(input: PluginInput): V1RuntimeContractFixture {
  return createV1RuntimeContract(input);
}
