import { decideTaskTransition } from "../domain/task-state.mjs";

function evidence(parameters) {
  return parameters?.evidenceId;
}

export const TASK_COMMAND_HANDLERS = {
  start_analysis(state) {
    return decideTaskTransition({ from: state, to: "analyzing" });
  },
  analysis_completed(state) {
    return decideTaskTransition({ from: state, to: "ready_for_development" });
  },
  analysis_needs_human(state) {
    return decideTaskTransition({ from: state, to: "waiting_info" });
  },
  analysis_restarted(state) {
    return decideTaskTransition({ from: state, to: "analyzing" });
  },
  start_development(state) {
    return decideTaskTransition({ from: state, to: "developing" });
  },
  development_completed(state) {
    return decideTaskTransition({ from: state, to: "ready_for_test" });
  },
  development_failed(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "ready_for_development",
      evidenceId: evidence(parameters),
    });
  },
  start_test(state) {
    return decideTaskTransition({ from: state, to: "testing" });
  },
  test_passed(state) {
    return decideTaskTransition({ from: state, to: "ready_for_acceptance" });
  },
  test_failed(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "ready_for_development",
      evidenceId: evidence(parameters),
    });
  },
  start_acceptance(state) {
    return decideTaskTransition({ from: state, to: "accepting" });
  },
  acceptance_passed(state) {
    return decideTaskTransition({ from: state, to: "ready_for_release" });
  },
  acceptance_failed(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "ready_for_development",
      evidenceId: evidence(parameters),
    });
  },
  publish_task(state) {
    return decideTaskTransition({ from: state, to: "published" });
  },
};
