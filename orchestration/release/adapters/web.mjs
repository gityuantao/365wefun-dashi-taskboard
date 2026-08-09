export function createWebAdapter({ deployer }) {
  return {
    async release({ manifest }) {
      if (!deployer) {
        throw new Error("web deployer not configured");
      }
      const preflight = await deployer.preflight?.({ manifest });
      if (preflight && preflight.ok === false) {
        throw new Error("preflight failed");
      }
      const digest = manifest.checksum;
      const upload = await deployer.upload({
        versionId: manifest.versionId,
        digest,
        candidateCommit: manifest.candidateCommit,
        artifactIdentity: manifest.artifactIdentity,
      });
      const entry = await deployer.switchEntry({
        versionId: manifest.versionId,
        candidateCommit: manifest.candidateCommit,
        artifactIdentity: manifest.artifactIdentity,
        upload,
      });
      const health = await deployer.healthCheck({ url: entry.url });
      if (!health.ok) {
        throw new Error(`health check failed with status ${health.status}`);
      }
      return {
        url: entry.url,
        digest,
        evidence: {
          object: upload.object,
          etag: upload.etag ?? null,
          url: entry.url,
          collectedAt: new Date().toISOString(),
        },
      };
    },
    async readback({ manifest, deployment }) {
      if (!deployer || typeof deployer.readback !== "function") {
        throw new Error("web deployer readback not configured");
      }
      const observed = await deployer.readback({
        versionId: manifest.versionId,
        url: deployment?.url ?? null,
      });
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
        || typeof observed?.candidateCommit !== "string"
        || observed.candidateCommit.trim() === ""
        || !hasArtifactIdentity
      ) {
        throw new Error("web deployer readback incomplete");
      }
      return {
        confirmed: true,
        published: true,
        candidateCommit: observed.candidateCommit,
        artifactIdentity,
        url: observed.url ?? deployment?.url ?? null,
        evidence: observed.evidence ?? null,
      };
    },
  };
}
