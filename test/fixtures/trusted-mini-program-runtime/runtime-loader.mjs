import provider from "./sandbox-providers/fake.mjs";
import stageRunner from "./stage-runners/fake.mjs";

export function createTrustedMiniProgramTestRuntime({
  sandboxProviderModule = "fake.mjs",
  stageRunnerModule = "fake.mjs",
} = {}) {
  if (sandboxProviderModule !== "fake.mjs" || stageRunnerModule !== "fake.mjs") {
    throw new Error("test runtime accepts only relative allowlisted fixed fake modules");
  }
  return Object.freeze({ provider, stageRunner });
}
