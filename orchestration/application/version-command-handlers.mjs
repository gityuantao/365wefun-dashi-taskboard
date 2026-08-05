import { decideVersionTransition } from "../domain/version-state.mjs";

function evidence(parameters) {
  return parameters?.evidenceId;
}

export const VERSION_COMMAND_HANDLERS = {
  prepare_release(state) {
    return decideVersionTransition({ from: state, to: "ready_for_release" });
  },
  start_release(state) {
    return decideVersionTransition({ from: state, to: "releasing" });
  },
  release_succeeded(state) {
    return decideVersionTransition({ from: state, to: "published" });
  },
  release_failed(state, parameters) {
    return decideVersionTransition({
      from: state,
      to: "release_failed",
      evidenceId: evidence(parameters),
    });
  },
};
