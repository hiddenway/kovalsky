import type { AgentDefinition } from "@/lib/types";

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "codex-cli",
    title: "Codex",
    description: "Generates implementation patches and technical changes.",
    icon: "🧠",
    outputs: ["CodePatch", "Summary"],
  },
  {
    id: "openclaw",
    title: "OpenClaw",
    description: "Can launch a browser and perform absolutely any actions on the device.",
    icon: "🦞",
    outputs: ["TestReport", "Url", "Screenshot"],
  },
];

export type AgentSettingField = {
  key: string;
  label: string;
  type: "boolean" | "text" | "textarea" | "number" | "select";
  description?: string;
  defaultValue?: boolean | string | number;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  step?: number;
};

const CODEX_MODEL_SUGGESTIONS: Array<{ label: string; value: string }> = [
  { label: "GPT-5.2 Codex (default)", value: "gpt-5.2-codex" },
  { label: "GPT-5.1 Codex", value: "gpt-5.1-codex" },
  { label: "GPT-5.3 Codex", value: "gpt-5.3-codex" },
];

const OPENCLAW_MODEL_SUGGESTIONS: Array<{ label: string; value: string }> = [
  { label: "OpenAI Codex GPT-5.2 (OAuth-safe)", value: "openai-codex/gpt-5.2-codex" },
  { label: "OpenAI Codex GPT-5.3", value: "openai-codex/gpt-5.3-codex" },
  { label: "OpenAI Codex GPT-5.3 Spark", value: "openai-codex/gpt-5.3-codex-spark" },
  { label: "OpenAI GPT-5.1 Codex (API key)", value: "openai/gpt-5.1-codex" },
];

const DEFAULT_CODEX_REPORT_PROMPT_TEMPLATE = [
  "Generate a concise human-readable post-step report.",
  "No tool calls, no commands, no file edits. Reply with plain text only.",
  "Original goal: {{goal}}",
  "Follow-up user request: {{followupPrompt}}",
  "Prioritize answering the follow-up request using existing run context.",
  "Reply in the same language as the follow-up user request.",
  "Step status: {{stepStatus}}",
  "Step error: {{stepError}}",
  "Artifacts: {{artifacts}}",
  "Log tail:",
  "{{logTail}}",
  "Format: 1) What was done 2) Main outcome 3) Links/paths to check 4) If failed, concrete fix steps.",
].join("\n");

const DEFAULT_OPENCLAW_REPORT_PROMPT_TEMPLATE = [
  "Generate a concise human-readable post-step report.",
  "No tool calls. Plain text only.",
  "Original goal: {{goal}}",
  "Follow-up user request: {{followupPrompt}}",
  "Prioritize answering the follow-up request using the existing step context.",
  "Reply in the same language as the follow-up user request.",
  "Resolved URL candidates: {{urls}}",
  "Step status: {{stepStatus}}",
  "Step error: {{stepError}}",
  "Artifacts: {{artifacts}}",
  "Log tail:",
  "{{logTail}}",
  "Format: What was done / Outcome / Links to verify / Next actions.",
].join("\n");

const AGENT_SETTING_FIELDS: Record<string, AgentSettingField[]> = {
  "codex-cli": [
    {
      key: "command",
      label: "Command",
      type: "text",
      defaultValue: "codex",
      placeholder: "codex",
      description: "Executable used to run Codex.",
    },
    {
      key: "model",
      label: "Model",
      type: "text",
      defaultValue: "",
      placeholder: "gpt-5.2-codex",
      options: CODEX_MODEL_SUGGESTIONS,
      description: "Optional model override passed as --model for this node.",
    },
    {
      key: "passGoalAsArg",
      label: "Pass Goal As Arg",
      type: "boolean",
      defaultValue: true,
      description: "Append node goal to command arguments.",
    },
    {
      key: "dangerouslyBypassSandbox",
      label: "Bypass Sandbox",
      type: "boolean",
      defaultValue: true,
      description: "Use fully-automated mode without sandbox approvals.",
    },
    {
      key: "reportPromptTemplate",
      label: "Report Prompt Template",
      type: "textarea",
      defaultValue: DEFAULT_CODEX_REPORT_PROMPT_TEMPLATE,
      placeholder:
        "Optional custom template for post-step and chat follow-up reports. Use {{goal}}, {{followupPrompt}}, {{stepStatus}}, {{stepError}}, {{artifacts}}, {{logTail}}.",
      description: "Per-node report prompt template used for post-step and chat follow-up.",
    },
  ],
  openclaw: [
    {
      key: "command",
      label: "Command",
      type: "text",
      defaultValue: "openclaw",
      placeholder: "openclaw",
      description: "Executable used to run OpenClaw.",
    },
    {
      key: "mode",
      label: "Mode",
      type: "select",
      defaultValue: "agent-local",
      options: [
        { label: "Agent Local", value: "agent-local" },
        { label: "Raw Args", value: "raw" },
      ],
    },
    {
      key: "useProfile",
      label: "Use Profile",
      type: "boolean",
      defaultValue: false,
      description: "Enable predefined profile flags.",
    },
    {
      key: "profile",
      label: "Profile",
      type: "select",
      defaultValue: "full",
      options: [
        { label: "Full", value: "full" },
        { label: "Smoke", value: "smoke" },
      ],
    },
    {
      key: "agentId",
      label: "Agent ID",
      type: "text",
      defaultValue: "main",
      placeholder: "main",
    },
    {
      key: "model",
      label: "Model",
      type: "text",
      defaultValue: "",
      placeholder: "openai-codex/gpt-5.2-codex",
      options: OPENCLAW_MODEL_SUGGESTIONS,
      description: "Optional model override written to OpenClaw agent config for this node run.",
    },
    {
      key: "thinking",
      label: "Thinking",
      type: "select",
      defaultValue: "minimal",
      options: [
        { label: "Off", value: "off" },
        { label: "Minimal", value: "minimal" },
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
        { label: "High", value: "high" },
      ],
    },
    {
      key: "timeoutSeconds",
      label: "Timeout (sec)",
      type: "number",
      defaultValue: 240,
      min: 1,
      step: 1,
    },
    {
      key: "persistBackgroundProcesses",
      label: "Keep Background Services",
      type: "boolean",
      defaultValue: false,
      description: "Allow server/background process to stay alive after step completes.",
    },
    {
      key: "passGoalAsArg",
      label: "Pass Goal As Arg",
      type: "boolean",
      defaultValue: false,
      description: "Append goal as CLI argument in raw mode.",
    },
    {
      key: "goalFlag",
      label: "Goal Flag",
      type: "text",
      defaultValue: "--goal",
      placeholder: "--goal",
    },
    {
      key: "reportPromptTemplate",
      label: "Report Prompt Template",
      type: "textarea",
      defaultValue: DEFAULT_OPENCLAW_REPORT_PROMPT_TEMPLATE,
      placeholder:
        "Optional custom template for post-step and chat follow-up reports. Use {{goal}}, {{followupPrompt}}, {{stepStatus}}, {{stepError}}, {{artifacts}}, {{logTail}}, {{urls}}.",
      description: "Per-node report prompt template used for post-step and chat follow-up.",
    },
  ],
};

const AGENT_ALIASES: Record<string, string> = {
  codex: "codex-cli",
  "codex-cli": "codex-cli",
  openclaw: "openclaw",
};

export function normalizeAgentId(agentId: string): string {
  return AGENT_ALIASES[agentId] ?? agentId;
}

export function getAgentById(agentId: string): AgentDefinition | undefined {
  const normalizedId = normalizeAgentId(agentId);
  return AGENT_DEFINITIONS.find((agent) => agent.id === normalizedId);
}

export function getSupportedAgents(agents: AgentDefinition[]): AgentDefinition[] {
  const catalog = new Map(AGENT_DEFINITIONS.map((agent) => [agent.id, agent]));
  const selected = new Map<string, AgentDefinition>();

  for (const agent of agents) {
    const normalizedId = normalizeAgentId(agent.id);
    const known = catalog.get(normalizedId);
    if (!known || selected.has(normalizedId)) {
      continue;
    }

    selected.set(normalizedId, {
      ...known,
      inputs: agent.inputs ?? known.inputs,
      outputs: agent.outputs ?? known.outputs,
      configSchema: agent.configSchema ?? known.configSchema,
    });
  }

  if (selected.size > 0) {
    return [...selected.values()];
  }

  return AGENT_DEFINITIONS;
}

export function getAgentSettingFields(agentId: string): AgentSettingField[] {
  const normalizedId = normalizeAgentId(agentId);
  return AGENT_SETTING_FIELDS[normalizedId] ?? [];
}
