import {
  checkVersionGate,
  freezeManifest,
  loadAllTaskSnapshots,
  loadManifest,
} from "../release/version-aggregator.mjs";
import { classifyCandidateChanges } from "../release/candidate-scope.mjs";
import { loadAggregate } from "../persistence/d1-aggregate-store.mjs";
import {
  assertProductionTargetPlanMatches,
  buildProductionTargetPlan,
} from "../release/production-target-plan.mjs";
import { assertProductionPlatformsSupported } from "../release/platform-gate.mjs";
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
  loadAllTaskSnapshots,
  loadAggregate,
  removeTaskWorktree,
  closeTaskPullRequest,
  deleteRemoteTaskBranch,
  confirmPublishedCandidate,
  handleConfirmRelease,
  loadCleanupAttempts,
  loadTaskPullRequest,
  recordCleanupAttempt,
  classifyCandidateChanges,
};

export async function coordinateReleaseSnapshot({
  snapshot,
  now,
  db,
  adapter,
  miniProgramAdapter = null,
  iosAdapter = null,
  apps = null,
  releaseLease = null,
  client,
  runtime,
  repository,
  releaseGitOps,
  productionReadiness = { ready: false, error: "production readiness probe was not configured" },
  prepareProductionRuntime = null,
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
  if (!cleanupRetry && productionReadiness?.ready !== true) {
    return {
      status: "rejected",
      error: `production runtime is not ready: ${productionReadiness?.error ?? "invalid configuration"}`,
    };
  }
  if (!cleanupRetry && !existingManifest && typeof prepareProductionRuntime === "function") {
    try {
      await prepareProductionRuntime();
    } catch (error) {
      return {
        status: "rejected",
        error: `production runtime preflight failed: ${error.message}`,
      };
    }
  }
  if (!existingManifest && (
    !adapter
    || (
      typeof adapter.collectRegressionEvidence !== "function"
      || typeof adapter.identifyArtifact !== "function"
    )
  )) {
    return { status: "rejected", error: "configured deployer and Candidate evidence providers required" };
  }

  const allTaskSnapshots = cleanupRetry ? [] : await services.loadAllTaskSnapshots(db);
  const versionTaskSnapshots = cleanupRetry ? [] : allTaskSnapshots.filter(
    (task) => task.targetVersion === (snapshot.name ?? versionId),
  );
  const expectedTaskIds = existingManifest?.taskIds ?? versionTaskSnapshots
    .map((task) => task.id)
    .sort();
  const releaseTaskSnapshots = existingManifest && versionTaskSnapshots.length > 0
    ? versionTaskSnapshots
    : allTaskSnapshots.filter((task) => expectedTaskIds.includes(task.id));
  let productionTargetPlan = existingManifest?.productionTargetPlan;
  if (!cleanupRetry && existingManifest) {
    try {
      const currentPlan = buildProductionTargetPlan({
        taskSnapshots: releaseTaskSnapshots,
        taskIds: expectedTaskIds,
        apps: apps ?? runtime?.iosApps ?? [],
        marketingVersion: String(snapshot.name ?? versionId).replace(/^v(?=\d)/, ""),
      });
      assertProductionTargetPlanMatches(existingManifest.productionTargetPlan, currentPlan);
    } catch (error) {
      return { status: "rejected", error: `production target plan validation failed: ${error.message}` };
    }
  }
  if (!cleanupRetry && !existingManifest) {
    try {
      const declaredScope = releaseTaskSnapshots.filter((task) => Array.isArray(task.platforms) && task.platforms.length > 0);
      if (declaredScope.length > 0) assertProductionPlatformsSupported(declaredScope);
    } catch (error) {
      return { status: "rejected", error: `production target plan validation failed: ${error.message}` };
    }
  }

  const taskIds = expectedTaskIds;
  const versionBranch = existingManifest?.versionBranch ?? `version/${snapshot.name ?? versionId}`;
  const result = await coordinateVersionRelease({
    versionId,
    versionBranch,
    taskIds,
    now,
    existingManifest,
    publicationAlreadyConfirmed: cleanupRetry,
    integrateTaskPr: async ({ taskId }) => releaseGitOps.integrateTaskPr({
      taskId,
      pullRequest: await services.loadTaskPullRequest({ db, taskId }),
      versionBranch,
    }),
    collectRegressionEvidence: (candidate) => adapter.collectRegressionEvidence(candidate),
    identifyArtifact: (candidate) => adapter.identifyArtifact(candidate),
    persistCandidate: (candidate) => releaseGitOps.persistCandidate(candidate),
    ...(typeof releaseGitOps.resolveCandidateBase === "function"
      ? { resolveCandidateBase: (candidate) => releaseGitOps.resolveCandidateBase(candidate) }
      : {}),
    freezeCandidate: async (candidate) => {
      let candidateScope;
      try {
        candidateScope = services.classifyCandidateChanges({
          repoPath: runtime.repoPath,
          baseCommit: candidate.candidateBaseCommit,
          candidateCommit: candidate.candidateCommit,
        });
      } catch (error) {
        return { status: "rejected", reasons: [error.message] };
      }
      const runtimeReadiness = {
        ...productionReadiness,
        configuredTargets: runtime?.configuredTargets ?? productionReadiness?.configuredTargets ?? [],
      };
      const gate = await services.checkVersionGate({ db, versionId, candidateScope, runtimeReadiness });
      if (!gate.pass) return { status: "rejected", reasons: gate.reasons };
      const eligibility = gate.releaseEligibility ?? gate;
      try {
        productionTargetPlan = buildProductionTargetPlan({
          taskSnapshots: eligibility.taskPlatforms.map(({ taskId, platforms }) => ({ id: taskId, platforms })),
          taskIds: eligibility.taskIds,
          apps: apps ?? runtime?.iosApps ?? [],
          marketingVersion: String(snapshot.name ?? versionId).replace(/^v(?=\d)/, ""),
        });
      } catch (error) {
        return { status: "rejected", reasons: [`production target plan validation failed: ${error.message}`] };
      }
      return services.freezeManifest({
        db,
        ...candidate,
        candidateScope,
        productionTargetPlan,
        runtimeReadiness,
      });
    },
    verifyCandidate: (candidate) => releaseGitOps.verifyCandidate(candidate),
    publishCandidate: async ({ manifest }) => {
      return services.handleConfirmRelease({
        db,
        versionId,
        actorId: "system-poller",
        actorRoles: ["release_manager"],
        now,
        adapter,
        miniProgramAdapter,
        iosAdapter,
        targetPlanValidated: true,
        lease: releaseLease,
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
