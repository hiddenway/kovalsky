import type { Pipeline } from "@/lib/types";

type WritableLike = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type FileHandleLike = {
  name?: string;
  createWritable: () => Promise<WritableLike>;
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileHandleLike>;
};

const DB_NAME = "kovalsky_pipeline_files";
const DB_VERSION = 1;
const STORE_NAME = "handles";

function buildHandleKey(pipelineId: string): string {
  return `pipeline:${pipelineId}`;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSuggestedFilename(pipeline: Pipeline): string {
  const stem = slugify(pipeline.name || "workflow");
  return `${stem || "workflow"}.json`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function getStoredHandle(pipelineId: string): Promise<FileHandleLike | null> {
  try {
    const db = await openDb();
    const key = buildHandleKey(pipelineId);
    const handle = await new Promise<FileHandleLike | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onerror = () => reject(request.error ?? new Error("Failed to read file handle"));
      request.onsuccess = () => resolve((request.result as FileHandleLike | undefined) ?? null);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

async function storeHandle(pipelineId: string, handle: FileHandleLike): Promise<void> {
  try {
    const db = await openDb();
    const key = buildHandleKey(pipelineId);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(handle, key);
      request.onerror = () => reject(request.error ?? new Error("Failed to persist file handle"));
      request.onsuccess = () => resolve();
    });
    db.close();
  } catch {
    return;
  }
}

async function clearStoredHandle(pipelineId: string): Promise<void> {
  try {
    const db = await openDb();
    const key = buildHandleKey(pipelineId);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onerror = () => reject(request.error ?? new Error("Failed to clear file handle"));
      request.onsuccess = () => resolve();
    });
    db.close();
  } catch {
    return;
  }
}

async function ensureWritePermission(handle: FileHandleLike): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) {
    return true;
  }

  const query = await handle.queryPermission({ mode: "readwrite" });
  if (query === "granted") {
    return true;
  }

  const request = await handle.requestPermission({ mode: "readwrite" });
  return request === "granted";
}

async function writeToHandle(handle: FileHandleLike, json: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
}

function downloadJson(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isStaleFileHandleError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "NotAllowedError");
}

export function isUserCanceledFileDialog(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function savePipelineToFile(
  pipeline: Pipeline,
  json: string,
): Promise<{ mode: "updated" | "created" | "downloaded"; fileName: string }> {
  const filename = getSuggestedFilename(pipeline);
  const existingHandle = await getStoredHandle(pipeline.id);

  if (existingHandle && (await ensureWritePermission(existingHandle))) {
    try {
      await writeToHandle(existingHandle, json);
      return {
        mode: "updated",
        fileName: existingHandle.name ?? filename,
      };
    } catch (error) {
      if (!isStaleFileHandleError(error)) {
        throw error;
      }
      await clearStoredHandle(pipeline.id);
    }
  }

  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") {
    downloadJson(filename, json);
    return {
      mode: "downloaded",
      fileName: filename,
    };
  }

  const pickedHandle = await picker({
    suggestedName: filename,
    types: [
      {
        description: "Workflow JSON",
        accept: {
          "application/json": [".json"],
        },
      },
    ],
  });

  await writeToHandle(pickedHandle, json);
  await storeHandle(pipeline.id, pickedHandle);

  return {
    mode: "created",
    fileName: pickedHandle.name ?? filename,
  };
}
