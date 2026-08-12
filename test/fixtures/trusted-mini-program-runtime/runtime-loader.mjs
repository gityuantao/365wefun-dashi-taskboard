import { createTrustedMiniProgramRuntimeLoader } from "../../../orchestration/mini-program/trusted-runtime-loader.mjs";
import { runCliMain } from "../../../scripts/release-mini-program.mjs";

const TEST_AUTHORITY = Object.freeze({});

export function isTrustedMiniProgramTestAuthority(value) {
  return value === TEST_AUTHORITY;
}

export function createTrustedMiniProgramTestRuntime({
  sandboxProviderModule = "fake.mjs",
  stageRunnerModule = "fake.mjs",
} = {}) {
  return createTrustedMiniProgramRuntimeLoader({
    sandboxProviderModule,
    stageRunnerModule,
    testAuthority: TEST_AUTHORITY,
  });
}

export function runTrustedMiniProgramTestCliMain(options = {}) {
  return runCliMain({ ...options, testAuthority: TEST_AUTHORITY });
}
