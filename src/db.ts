import Database from "better-sqlite3";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { ensureDir } from "./utils/fs";
import { nowIso } from "./utils/time";
import type {
  ArtifactRecord,
  NodeMessagePhase,
  NodeMessageRecord,
  NodeMessageRole,
  PipelineRecord,
  RunPlanRecord,
  RunRecord,
  RunStatus,
  SecretRecord,
  StepRunRecord,
  StepStatus,
} from "./types";

export class DatabaseService {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        runner_type TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_summary TEXT,
        FOREIGN KEY(pipeline_id) REFERENCES pipelines(id)
      );

      CREATE TABLE IF NOT EXISTS step_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        error_summary TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        produced_by_step_run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        meta_json TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(produced_by_step_run_id) REFERENCES step_runs(id)
      );

      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        keychain_ref TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_plans (
        run_id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS node_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT NOT NULL,
        phase TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        meta_json TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_step_runs_run_id ON step_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
      CREATE INDEX IF NOT EXISTS idx_node_messages_run_node ON node_messages(run_id, node_id, created_at);
    `);
  }

  upsertAgent(agent: {
    id: string;
    version: string;
    title: string;
    runnerType: string;
    manifestJson: string;
  }): void {
    this.db.prepare(`
      INSERT INTO agents (id, version, title, runner_type, manifest_json)
      VALUES (@id, @version, @title, @runnerType, @manifestJson)
      ON CONFLICT(id) DO UPDATE SET
        version=excluded.version,
        title=excluded.title,
        runner_type=excluded.runner_type,
        manifest_json=excluded.manifest_json
    `).run(agent);
  }

  listAgents(): Array<{ id: string; version: string; title: string; runner_type: string; manifest_json: string }> {
    return this.db.prepare("SELECT * FROM agents ORDER BY id ASC").all() as Array<{ id: string; version: string; title: string; runner_type: string; manifest_json: string }>;
  }

  createPipeline(name: string, graphJson: string, pipelineId?: string): PipelineRecord {
    const id = pipelineId?.trim() || uuidv4();
    const existing = this.getPipeline(id);
    if (existing) {
      const updated = this.updatePipeline(id, name, graphJson);
      if (updated) {
        return updated;
      }
    }

    const record: PipelineRecord = {
      id,
      name,
      graph_json: graphJson,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.db.prepare(`
      INSERT INTO pipelines (id, name, graph_json, created_at, updated_at)
      VALUES (@id, @name, @graph_json, @created_at, @updated_at)
    `).run(record);
    return record;
  }

  getPipeline(id: string): PipelineRecord | null {
    return (this.db.prepare("SELECT * FROM pipelines WHERE id = ?").get(id) as PipelineRecord | undefined) ?? null;
  }

  listPipelines(): PipelineRecord[] {
    return this.db.prepare("SELECT * FROM pipelines ORDER BY updated_at DESC, id ASC").all() as PipelineRecord[];
  }

  updatePipeline(id: string, name: string, graphJson: string): PipelineRecord | null {
    const existing = this.getPipeline(id);
    if (!existing) {
      return null;
    }
    const updatedAt = nowIso();
    this.db.prepare(`
      UPDATE pipelines
      SET name = ?, graph_json = ?, updated_at = ?
      WHERE id = ?
    `).run(name, graphJson, updatedAt, id);
    return this.getPipeline(id);
  }

  createRun(pipelineId: string): RunRecord {
    const record: RunRecord = {
      id: uuidv4(),
      pipeline_id: pipelineId,
      status: "queued",
      started_at: null,
      finished_at: null,
      error_summary: null,
    };
    this.db.prepare(`
      INSERT INTO runs (id, pipeline_id, status, started_at, finished_at, error_summary)
      VALUES (@id, @pipeline_id, @status, @started_at, @finished_at, @error_summary)
    `).run(record);
    return record;
  }

  upsertRunPlan(runId: string, pipelineId: string, planJson: string): RunPlanRecord {
    const record: RunPlanRecord = {
      run_id: runId,
      pipeline_id: pipelineId,
      plan_json: planJson,
      created_at: nowIso(),
    };

    this.db.prepare(`
      INSERT INTO run_plans (run_id, pipeline_id, plan_json, created_at)
      VALUES (@run_id, @pipeline_id, @plan_json, @created_at)
      ON CONFLICT(run_id) DO UPDATE SET
        pipeline_id=excluded.pipeline_id,
        plan_json=excluded.plan_json,
        created_at=excluded.created_at
    `).run(record);

    return record;
  }

  getRunPlan(runId: string): RunPlanRecord | null {
    return (this.db.prepare("SELECT * FROM run_plans WHERE run_id = ?").get(runId) as RunPlanRecord | undefined) ?? null;
  }

  getRun(runId: string): RunRecord | null {
    return (this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRecord | undefined) ?? null;
  }

  updateRunStatus(runId: string, status: RunStatus, errorSummary: string | null = null): void {
    const startedAt = status === "running" ? nowIso() : undefined;
    const finishedAt = ["success", "failed", "canceled"].includes(status) ? nowIso() : undefined;

    this.db.prepare(`
      UPDATE runs
      SET status = ?,
          started_at = COALESCE(?, started_at),
          finished_at = COALESCE(?, finished_at),
          error_summary = ?
      WHERE id = ?
    `).run(status, startedAt ?? null, finishedAt ?? null, errorSummary, runId);
  }

  createStepRun(runId: string, nodeId: string, agentId: string): StepRunRecord {
    const record: StepRunRecord = {
      id: uuidv4(),
      run_id: runId,
      node_id: nodeId,
      agent_id: agentId,
      status: "pending",
      started_at: null,
      finished_at: null,
      exit_code: null,
      error_summary: null,
    };
    this.db.prepare(`
      INSERT INTO step_runs (id, run_id, node_id, agent_id, status, started_at, finished_at, exit_code, error_summary)
      VALUES (@id, @run_id, @node_id, @agent_id, @status, @started_at, @finished_at, @exit_code, @error_summary)
    `).run(record);
    return record;
  }

  updateStepRunStatus(
    stepRunId: string,
    status: StepStatus,
    exitCode: number | null = null,
    errorSummary: string | null = null,
  ): void {
    const startedAt = status === "running" ? nowIso() : undefined;
    const finishedAt = ["success", "failed", "skipped", "canceled"].includes(status) ? nowIso() : undefined;

    this.db.prepare(`
      UPDATE step_runs
      SET status = ?,
          started_at = COALESCE(?, started_at),
          finished_at = COALESCE(?, finished_at),
          exit_code = ?,
          error_summary = ?
      WHERE id = ?
    `).run(status, startedAt ?? null, finishedAt ?? null, exitCode, errorSummary, stepRunId);
  }

  getStepRunsByRun(runId: string): StepRunRecord[] {
    return this.db.prepare("SELECT * FROM step_runs WHERE run_id = ? ORDER BY started_at ASC, id ASC").all(runId) as StepRunRecord[];
  }

  getStepRunByNode(runId: string, nodeId: string): StepRunRecord | null {
    return (this.db.prepare(`
      SELECT * FROM step_runs
      WHERE run_id = ? AND node_id = ?
      ORDER BY COALESCE(started_at, finished_at, '') DESC, id DESC
      LIMIT 1
    `).get(runId, nodeId) as StepRunRecord | undefined) ?? null;
  }

  createArtifact(entry: {
    run_id: string;
    produced_by_step_run_id: string;
    type: string;
    title: string;
    path: string;
    mime: string;
    size: number;
    meta_json: string | null;
  }): ArtifactRecord {
    const record: ArtifactRecord = {
      id: uuidv4(),
      created_at: nowIso(),
      ...entry,
    };

    this.db.prepare(`
      INSERT INTO artifacts (
        id, run_id, produced_by_step_run_id, type, title, path, mime, size, created_at, meta_json
      ) VALUES (
        @id, @run_id, @produced_by_step_run_id, @type, @title, @path, @mime, @size, @created_at, @meta_json
      )
    `).run(record);

    return record;
  }

  getArtifactsByRun(runId: string): ArtifactRecord[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC").all(runId) as ArtifactRecord[];
  }

  getArtifact(artifactId: string): ArtifactRecord | null {
    return (this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as ArtifactRecord | undefined) ?? null;
  }

  listArtifactsForResolver(runId: string): Array<ArtifactRecord & { node_id: string }> {
    return this.db.prepare(`
      SELECT a.*, s.node_id
      FROM artifacts a
      JOIN step_runs s ON s.id = a.produced_by_step_run_id
      WHERE a.run_id = ?
      ORDER BY a.created_at ASC
    `).all(runId) as Array<ArtifactRecord & { node_id: string }>;
  }

  createSecret(provider: string, label: string, keychainRef: string): SecretRecord {
    const record: SecretRecord = {
      id: uuidv4(),
      provider,
      label,
      created_at: nowIso(),
      keychain_ref: keychainRef,
    };

    this.db.prepare(`
      INSERT INTO secrets (id, provider, label, created_at, keychain_ref)
      VALUES (@id, @provider, @label, @created_at, @keychain_ref)
    `).run(record);

    return record;
  }

  updateSecretKeychainRef(id: string, keychainRef: string): void {
    this.db.prepare("UPDATE secrets SET keychain_ref = ? WHERE id = ?").run(keychainRef, id);
  }

  getSecret(id: string): SecretRecord | null {
    return (this.db.prepare("SELECT * FROM secrets WHERE id = ?").get(id) as SecretRecord | undefined) ?? null;
  }

  listSecrets(): SecretRecord[] {
    return this.db.prepare("SELECT * FROM secrets ORDER BY created_at DESC").all() as SecretRecord[];
  }

  deleteSecret(id: string): void {
    this.db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
  }

  createNodeMessage(input: {
    runId: string;
    nodeId: string;
    role: NodeMessageRole;
    phase: NodeMessagePhase;
    content: string;
    meta?: Record<string, unknown>;
  }): NodeMessageRecord {
    const record: NodeMessageRecord = {
      id: uuidv4(),
      run_id: input.runId,
      node_id: input.nodeId,
      role: input.role,
      phase: input.phase,
      content: input.content,
      created_at: nowIso(),
      meta_json: input.meta ? JSON.stringify(input.meta) : null,
    };

    this.db.prepare(`
      INSERT INTO node_messages (id, run_id, node_id, role, phase, content, created_at, meta_json)
      VALUES (@id, @run_id, @node_id, @role, @phase, @content, @created_at, @meta_json)
    `).run(record);

    return record;
  }

  listNodeMessages(runId: string, nodeId: string): NodeMessageRecord[] {
    return this.db.prepare(`
      SELECT * FROM node_messages
      WHERE run_id = ? AND node_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId, nodeId) as NodeMessageRecord[];
  }

  listNodeMessagesByPipelineNode(pipelineId: string, nodeId: string): NodeMessageRecord[] {
    return this.db.prepare(`
      SELECT nm.*
      FROM node_messages nm
      JOIN runs r ON r.id = nm.run_id
      WHERE r.pipeline_id = ? AND nm.node_id = ?
      ORDER BY nm.created_at ASC, nm.id ASC
    `).all(pipelineId, nodeId) as NodeMessageRecord[];
  }

  deleteNodeMessagesByPipeline(pipelineId: string): void {
    this.db.prepare(`
      DELETE FROM node_messages
      WHERE run_id IN (
        SELECT id
        FROM runs
        WHERE pipeline_id = ?
      )
    `).run(pipelineId);
  }
}
