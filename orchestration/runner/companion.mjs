import { DomainError } from "../domain/errors.mjs";

export async function runCompanionOnce({
  apiUrl,
  deviceId,
  jobType,
  handlers,
  fetchImpl = fetch,
}) {
  const claimUrl = [
    `${apiUrl}/api/runner/jobs/next`,
    `device_id=${encodeURIComponent(deviceId)}`,
    `job_type=${encodeURIComponent(jobType)}`,
  ].join("?");
  const claimResponse = await fetchImpl(claimUrl);
  if (claimResponse.status === 204) return { claimed: false };
  if (!claimResponse.ok) {
    throw new DomainError(
      `HTTP_${claimResponse.status}`,
      `Runner claim failed with ${claimResponse.status}`,
    );
  }
  const { job } = await claimResponse.json();
  const handler = handlers[job.jobType] ?? handlers.default;
  const postResult = async (status, result) => {
    const response = await fetchImpl(`${apiUrl}/api/runner/jobs/${job.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        fencingToken: job.fencingToken,
        status,
        result,
      }),
    });
    if (!response.ok) {
      throw new DomainError(
        `HTTP_${response.status}`,
        `Result post failed with ${response.status}`,
      );
    }
  };
  try {
    const result = await handler(job);
    await postResult("completed", result);
    return { claimed: true, jobId: job.id, status: "completed" };
  } catch (error) {
    await postResult("failed", { error: error.message });
    return { claimed: true, jobId: job.id, status: "failed" };
  }
}
