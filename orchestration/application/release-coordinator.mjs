import { checkVersionGate, freezeManifest, loadManifest } from "../release/version-aggregator.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import { removeTaskWorktree } from "../runner/worktree.mjs";
import { closeTaskPullRequest, deleteRemoteTaskBranch } from "../git/pr.mjs";
import {
  confirmPublishedCandidate,
  coordinateVersionRelease,
  handleConfirmRelease,
  loadCleanupAttempts,
  loadTaskPullRequest,
  recordCleanupAttempt,
} from "./release-commands.mjs";

const DEFAULT_SERVICES = {
  checkVersionGate,
  freezeManifest,
  loadManifest,
  loadAggregate,
  removeTaskWorktree,
  closeTaskPullRequest,
  deleteRemoteTaskBranch,
  confirmPublishedCandidate,
  handleConfirmRelease,
  loadCleanupAttempts,
  loadTaskPullRequest,
  recordCleanupAttempt,
};

export async function coordinateReleaseSnapshot({
  snapshot,
  now,
  db,
  adapter,
  client,
  runtime,
  repository,
  releaseGitOps,
  log = () => {},
  services: overrides = {},
}) {
  const services = { ...DEFAULT_SERVICES, ...overrides };
  const versionId = snapshot.id;
  const existingManifest = await services.loadManifest({ db, versionId });
  const versionAggregate = await services.loadAggregate(db, "version", versionId);
  const cleanupRetry = versionAggregate.state === "published" && existingManifest;
  if (snapshot.status !== "releasing" && !cleanupRetry) {
    return { status: "skipped" };
  }
  if (
    !adapter
    || typeof adapter.readback !== "function"
    || (versionAggregate.state !== "published" && typeof adapter.release !== "function")
    || (!existingManifest && (
      typeof adapter.collectRegressionEvidence !== "function"
      || typeof adapter.identifyArtifact !== "function"
    ))
  ) {
    return { status: "rejected", error: "configured deployer and Candidate evidence providers required" };
  }

  let taskIds = existingManifest?.taskIds ?? [];
  if (!existingManifest) {
    const gate = await services.checkVersionGate({ db, versionId });
    if (!gate.pass) {
      return { status: "rejected", error: gate.reasons.join("; ") };
    }
    taskIds = gate.taskIds;
  }
  const versionBranch = existingManifest?.versionBranch ?? `version/${snapshot.name ?? versionId}`;
  const result = await coordinateVersionRelease({
    versionId,
    versionBranch,
    taskIds,
    now,
    existingManifest,
    integrateTaskPr: async ({ taskId }) => releaseGitOps.integrateTaskPr({
      taskId,
      pullRequest: await services.loadTaskPullRequest({ db, taskId }),
      versionBranch,
    }),
    collectRegressionEvidence: (candidate) => adapter.collectRegressionEvidence(candidate),
    identifyArtifact: (candidate) => adapter.identifyArtifact(candidate),
    persistCandidate: (candidate) => releaseGitOps.persistCandidate(candidate),
    freezeCandidate: (candidate) => services.freezeManifest({ db, ...candidate }),
    verifyCandidate: (candidate) => releaseGitOps.verifyCandidate(candidate),
    publishCandidate: async ({ manifest }) => {
      if (versionAggregate.state === "published") {
        try {
          const publication = await services.confirmPublishedCandidate({ adapter, manifest });
          return { status: "succeeded", publication };
        } catch (error) {
          return { status: "failed", error: error.message };
        }
      }
      return services.handleConfirmRelease({
        db,
        versionId,
        actorId: "system-poller",
        actorRoles: ["release_manager"],
        now,
        adapter,
        client,
      });
    },
    cleanupOperations: [
      {
        name: "close_pull_request",
        run: ({ head }) => services.closeTaskPullRequest({
          branch: String(head.prNumber),
          repo: repository,
        }),
      },
      {
        name: "delete_remote_branch",
        run: ({ head }) => services.deleteRemoteTaskBranch({
          repoPath: runtime.repoPath,
          branch: head.branch,
        }),
      },
      {
        name: "remove_local_evidence",
        run: ({ head }) => services.removeTaskWorktree({
          repoPath: runtime.repoPath,
          taskId: head.taskId,
          worktreesRoot: runtime.worktreesRoot,
        }),
      },
    ],
    loadCleanupAttempts: (query) => services.loadCleanupAttempts({ db, ...query }),
    recordCleanupAttempt: (attempt) => services.recordCleanupAttempt({ db, ...attempt }),
  });
  log(`version ${versionId} release -> ${result.status}${result.error ? `: ${result.error}` : ""}`);
  if (result.cleanupResult) {
    log(`version ${versionId} cleanup result ${JSON.stringify(result.cleanupResult)}`);
  }
  return result;
}
