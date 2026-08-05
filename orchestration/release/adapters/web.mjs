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
      const upload = await deployer.upload({ versionId: manifest.versionId, digest });
      const entry = await deployer.switchEntry({ versionId: manifest.versionId });
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
  };
}
