export function createWebAdapter({ deployer }) {
  function preflightRejected() {
    const error = new Error("preflight failed");
    error.deterministic = true;
    error.failureClassification = "validation";
    return error;
  }

  async function stage(options, name, operation) {
    await options.recordStage?.(name);
    await options.beforeExternalOperation?.();
    try {
      return await operation();
    } finally {
      await options.afterExternalOperation?.();
    }
  }

  return {
    async release(options) {
      const { manifest, platform } = options;
      if (!deployer) {
        throw new Error("web deployer not configured");
      }
      const preflight = await stage(options, "preflight", () => deployer.preflight?.({ manifest, platform, signal: options.signal }));
      if (preflight && preflight.ok === false) {
        throw preflightRejected();
      }
      const digest = manifest.checksum;
      const upload = await stage(options, "upload", () => deployer.upload({
        manifest,
        versionId: manifest.versionId,
        digest,
        candidateCommit: manifest.candidateCommit,
        artifactIdentity: manifest.artifactIdentity,
        idempotencyKey: options.idempotencyKey,
        platform,
        signal: options.signal,
      }));
      await options.recordStage?.("upload", {
        externalRequestId: upload?.externalRequestId,
        artifactIdentity: manifest.artifactIdentity,
        observedEvidence: {
          platform,
          object: upload?.object ?? null,
          etag: upload?.etag ?? null,
          externalRequestId: upload?.externalRequestId ?? null,
        },
      });
      const entry = await stage(options, "switch", () => deployer.switchEntry({
        manifest,
        versionId: manifest.versionId,
        candidateCommit: manifest.candidateCommit,
        artifactIdentity: manifest.artifactIdentity,
        upload,
        idempotencyKey: options.idempotencyKey,
        platform,
        signal: options.signal,
      }));
      await options.recordStage?.("switch", {
        externalRequestId: upload?.externalRequestId,
        productionReleaseId: entry?.productionReleaseId,
        observedEvidence: {
          platform,
          url: entry?.url ?? null,
          productionReleaseId: entry?.productionReleaseId ?? null,
        },
      });
      const health = await stage(options, "health", () => deployer.healthCheck({
        manifest,
        url: entry.url,
        platform,
        signal: options.signal,
      }));
      if (!health.ok) {
        throw new Error(`health check failed with status ${health.status}`);
      }
      await options.recordStage?.("health", {
        healthStatus: "healthy",
        observedEvidence: { platform, healthStatus: "healthy" },
      });
      if (typeof upload?.externalRequestId !== "string" || upload.externalRequestId.trim() === "") {
        throw new Error("web deployer upload omitted externalRequestId");
      }
      if (typeof entry?.productionReleaseId !== "string" || entry.productionReleaseId.trim() === "") {
        throw new Error("web deployer switch omitted productionReleaseId");
      }
      const observedEvidence = {
        object: upload.object,
        etag: upload.etag ?? null,
        url: entry.url,
        externalRequestId: upload.externalRequestId,
        productionReleaseId: entry.productionReleaseId,
        artifactIdentity: manifest.artifactIdentity,
        healthStatus: "healthy",
        collectedAt: new Date().toISOString(),
      };
      return {
        url: entry.url,
        digest,
        externalRequestId: upload.externalRequestId,
        productionReleaseId: entry.productionReleaseId,
        artifactIdentity: manifest.artifactIdentity,
        healthStatus: "healthy",
        observedEvidence,
        evidence: observedEvidence,
      };
    },
    async readback(options) {
      const { manifest, deployment, readbackLocator, platform } = options;
      if (!deployer || typeof deployer.readback !== "function") {
        throw new Error("web deployer readback not configured");
      }
      const observed = await stage(options, "readback", () => deployer.readback({
        manifest,
        versionId: manifest.versionId,
        url: deployment?.url ?? null,
        productionReleaseId: deployment?.productionReleaseId ?? null,
        readbackLocator: readbackLocator ?? deployment ?? null,
        externalRequestId: options.externalRequestId ?? deployment?.externalRequestId ?? null,
        idempotencyKey: options.idempotencyKey,
        platform,
        signal: options.signal,
      }));
      const artifactIdentity = observed?.artifactIdentity;
      const hasArtifactIdentity = typeof artifactIdentity === "string"
        ? artifactIdentity.trim() !== ""
        : artifactIdentity !== null
          && typeof artifactIdentity === "object"
          && !Array.isArray(artifactIdentity)
          && Object.keys(artifactIdentity).length > 0;
      if (
        observed?.confirmed !== true
        || observed?.published !== true
        || !["published", "live"].includes(observed?.status)
        || observed?.authoritative !== true
        || typeof observed?.candidateCommit !== "string"
        || observed.candidateCommit.trim() === ""
        || !hasArtifactIdentity
        || typeof observed?.productionReleaseId !== "string"
        || observed.productionReleaseId.trim() === ""
        || typeof observed?.externalRequestId !== "string"
        || observed.externalRequestId.trim() === ""
        || observed?.healthStatus !== "healthy"
        || observed?.evidence == null
      ) {
        throw new Error("web deployer readback incomplete");
      }
      return {
        confirmed: true,
        published: true,
        status: observed.status,
        authoritative: true,
        candidateCommit: observed.candidateCommit,
        artifactIdentity,
        externalRequestId: observed.externalRequestId,
        productionReleaseId: observed.productionReleaseId,
        healthStatus: observed.healthStatus,
        readbackStatus: "confirmed",
        url: observed.url ?? deployment?.url ?? null,
        observedEvidence: deployment?.observedEvidence ?? deployment?.evidence ?? null,
        readbackEvidence: observed.evidence,
        evidence: observed.evidence,
      };
    },
  };
}
