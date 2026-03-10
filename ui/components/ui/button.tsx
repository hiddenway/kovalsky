import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "danger";
};

export function Button({ className, variant = "default", ...props }: Props): React.JSX.Element {
  return (
    <button
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "default" && "border-cyan-400/50 bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30",
        variant === "secondary" && "border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
        variant === "danger" && "border-rose-500/50 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20",
        className,
      )}
      {...props}
    />
  );
}
