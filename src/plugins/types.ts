import type { AgentManifest, RunnerPreparedCommand, StepExecutionContext } from "../types";

export interface AgentAdapter {
  prepareCommand(ctx: StepExecutionContext): Promise<RunnerPreparedCommand>;
}

export interface AgentPlugin {
  manifest: AgentManifest;
  adapter: AgentAdapter;
}
