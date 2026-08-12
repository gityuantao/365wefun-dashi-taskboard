export default async function fakeStageRunner(config) {
  const common = {
    appId: config.appId, version: config.version, candidateCommit: config.candidateCommit,
    manifestChecksum: config.manifestChecksum, artifactDigest: config.evidence.artifactDigest,
  };
  if (config.stage === "upload") return { ...common, uploadId: "upload-1" };
  if (config.stage === "readUpload") return { ...common, uploadId: "upload-1", authoritative: true };
  if (config.stage === "submitReview") return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1" };
  if (config.stage === "readReview") return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", reviewStatus: "approved", authoritative: true };
  if (config.stage === "release") return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1" };
  return { ...common, uploadId: "upload-1", reviewSubmissionId: "submission-1", reviewId: "review-1", releaseId: "release-1", liveId: "live-1", liveStatus: "live", authoritative: true };
}
