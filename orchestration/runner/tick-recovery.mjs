import { recoverRunnerJobs } from "../persistence/d1-runner-jobs.mjs";

export function recoverExpiredRunnerJobsOnTick(db, { now }) {
  return recoverRunnerJobs(db, { now });
}
