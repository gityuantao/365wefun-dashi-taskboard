import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTrustedMiniProgramTestRuntime } from "../../../orchestration/mini-program/trusted-runtime-loader.mjs";
import { runCliMain } from "../../../scripts/release-mini-program.mjs";
import provider from "./sandbox-providers/fake.mjs";
import stageRunner from "./stage-runners/fake.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
await runCliMain({
  environment: process.env,
  projectRoot,
  runtimeLoader: () => createTrustedMiniProgramTestRuntime({ projectRoot, provider, stageRunner }),
});
