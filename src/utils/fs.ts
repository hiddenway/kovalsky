import fs from "node:fs";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function fileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}
