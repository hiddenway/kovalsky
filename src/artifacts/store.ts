import fs from "node:fs";
import path from "node:path";
import { DatabaseService } from "../db";
import { ensureDir, fileSize } from "../utils/fs";
import type { ArtifactRecord } from "../types";

export class ArtifactStore {
  constructor(
    private readonly db: DatabaseService,
    private readonly runsDir: string,
  ) {
    ensureDir(this.runsDir);
  }

  getRunDir(runId: string): string {
    return path.join(this.runsDir, runId);
  }

  getStepDir(runId: string, stepRunId: string): string {
    return path.join(this.getRunDir(runId), "steps", stepRunId);
  }

  getStepLogPath(runId: string, stepRunId: string): string {
    return path.join(this.getStepDir(runId, stepRunId), "logs.txt");
  }

  ensureStepDirs(runId: string, stepRunId: string): void {
    ensureDir(this.getStepDir(runId, stepRunId));
    ensureDir(path.join(this.getRunDir(runId), "artifacts"));
  }

  createArtifactFromFile(input: {
    runId: string;
    stepRunId: string;
    type: string;
    title: string;
    sourceFilePath: string;
    mime: string;
    meta?: Record<string, unknown>;
  }): ArtifactRecord {
    const artifactIdDir = path.join(this.getRunDir(input.runId), "artifacts");
    ensureDir(artifactIdDir);

    const fileName = path.basename(input.sourceFilePath);
    const destinationDir = path.join(artifactIdDir, `${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    ensureDir(destinationDir);
    const destination = path.join(destinationDir, fileName);

    fs.copyFileSync(input.sourceFilePath, destination);

    return this.db.createArtifact({
      run_id: input.runId,
      produced_by_step_run_id: input.stepRunId,
      type: input.type,
      title: input.title,
      path: destination,
      mime: input.mime,
      size: fileSize(destination),
      meta_json: input.meta ? JSON.stringify(input.meta) : null,
    });
  }

  writeTextArtifact(input: {
    runId: string;
    stepRunId: string;
    type: string;
    title: string;
    content: string;
    fileName: string;
    mime: string;
    meta?: Record<string, unknown>;
  }): ArtifactRecord {
    const artifactBase = path.join(this.getRunDir(input.runId), "artifacts", `${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    ensureDir(artifactBase);
    const filePath = path.join(artifactBase, input.fileName);

    fs.writeFileSync(filePath, input.content, "utf8");

    return this.db.createArtifact({
      run_id: input.runId,
      produced_by_step_run_id: input.stepRunId,
      type: input.type,
      title: input.title,
      path: filePath,
      mime: input.mime,
      size: fileSize(filePath),
      meta_json: input.meta ? JSON.stringify(input.meta) : null,
    });
  }
}
