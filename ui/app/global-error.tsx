"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          alignItems: "center",
          background: "#0b1020",
          color: "#f8fafc",
          display: "flex",
          fontFamily: "system-ui, sans-serif",
          justifyContent: "center",
          margin: 0,
          minHeight: "100vh",
        }}
      >
        <main style={{ maxWidth: 560, padding: 24, textAlign: "center" }}>
          <h1 style={{ marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#cbd5e1", lineHeight: 1.5, marginBottom: 16 }}>
            The error was captured. Please retry the action.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: "#2563eb",
              border: 0,
              borderRadius: 8,
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
              padding: "10px 16px",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
