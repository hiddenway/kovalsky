"use client";

import { useToastStore } from "@/stores/toast-store";
import { cn } from "@/lib/utils";

export function Toaster(): React.JSX.Element {
  const toasts = useToastStore((state) => state.toasts);
  const removeToast = useToastStore((state) => state.removeToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            "pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg",
            toast.tone === "success" && "border-emerald-500/30 bg-emerald-950/80 text-emerald-200",
            toast.tone === "error" && "border-rose-500/30 bg-rose-950/80 text-rose-200",
            toast.tone === "info" && "border-zinc-700 bg-zinc-900 text-zinc-100",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{toast.title}</p>
              {toast.description ? <p className="mt-1 text-xs opacity-90">{toast.description}</p> : null}
            </div>
            <button
              type="button"
              className="pointer-events-auto rounded px-1 text-xs opacity-80 transition hover:opacity-100"
              onClick={() => removeToast(toast.id)}
            >
              x
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
