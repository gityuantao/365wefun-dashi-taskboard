import { runTrustedMiniProgramTestCliMain } from "./runtime-loader.mjs";

await runTrustedMiniProgramTestCliMain({
  environment: process.env,
});
