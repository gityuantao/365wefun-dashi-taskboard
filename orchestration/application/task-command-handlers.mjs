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
    return decideTaskTransition({ from: state, to: "accepting" });
  },
  development_failed(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "ready_for_development",
      evidenceId: evidence(parameters),
    });
  },
  development_needs_info(state) {
    return decideTaskTransition({ from: state, to: "waiting_info" });
  },
  development_restarted(state) {
    return decideTaskTransition({ from: state, to: "developing" });
  },
  start_test(state) {
    return decideTaskTransition({ from: state, to: "testing" });
  },
  test_passed(state) {
    return decideTaskTransition({ from: state, to: "ready_for_release" });
  },
  test_failed(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "ready_for_development",
      evidenceId: evidence(parameters),
    });
  },
  acceptance_passed(state) {
    return decideTaskTransition({ from: state, to: "ready_for_test" });
  },
  acceptance_failed(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "ready_for_development",
      evidenceId: evidence(parameters),
    });
  },
  acceptance_rejected(state, parameters) {
    return decideTaskTransition({
      from: state,
      to: "acceptance_rejected",
      evidenceId: evidence(parameters),
    });
  },
  acceptance_rejected_to_develop(state) {
    return decideTaskTransition({ from: state, to: "ready_for_development" });
  },
  acceptance_rejected_to_test(state) {
    return decideTaskTransition({ from: state, to: "ready_for_test" });
  },
  publish_task(state) {
    return decideTaskTransition({ from: state, to: "published" });
  },
};
