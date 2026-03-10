import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

function getDefaultAppDataDir(): string {
  if (process.env.KOVALSKY_APPDATA_DIR?.trim()) {
    return process.env.KOVALSKY_APPDATA_DIR.trim();
  }
  return path.join(os.homedir(), ".kovalsky");
}

export async function GET(): Promise<NextResponse> {
  const tokenPath = path.join(getDefaultAppDataDir(), "pairing-token");
  if (!fs.existsSync(tokenPath)) {
    return NextResponse.json({ token: "" });
  }

  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json({ token: "" });
  }
}
