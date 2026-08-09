export function stagingRsyncArgs({ worktree, host, releasePath }) {
  return [
    "-az",
    "--delete",
    "--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r",
    "--exclude", "node_modules",
    "--exclude", ".git",
    "--exclude", "apps/ios",
    "--exclude", "apps/mp",
    "--exclude", "apps/android",
    "--exclude", "apps/android-web-wrapper",
    "--exclude", ".env*",
    `${worktree}/`,
    `${host}:${releasePath}/`,
  ];
}

export function stagingProbeUrls() {
  return [
    "https://test-api.365english.online/health/ready",
    "https://test-au.365english.online/",
    "https://test-admin.365english.online/",
  ];
}
