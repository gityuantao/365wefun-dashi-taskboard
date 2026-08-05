import { runCompanionOnce } from "../orchestration/runner/companion.mjs";

const apiUrl = process.env.CODEX_TASKBOARD_URL ?? "http://127.0.0.1:47823";
const deviceId = process.env.COMPANION_DEVICE_ID ?? "device-local";
const jobType = process.env.COMPANION_JOB_TYPE ?? "analyze";
const intervalMs = Number(process.env.COMPANION_INTERVAL_MS ?? 5_000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

while (true) {
  try {
    const result = await runCompanionOnce({
      apiUrl,
      deviceId,
      jobType,
      handlers: {},
    });
    if (result.claimed) {
      console.log(`[companion] ${result.jobId} -> ${result.status}`);
    }
  } catch (error) {
    console.error(`[companion] ${error.message}`);
  }
  await sleep(intervalMs);
}
