import { EventEmitter } from "node:events";

export interface GatewayEvent {
  runId: string;
  type:
    | "run_status"
    | "step_status"
    | "log_line"
    | "progress"
    | "artifact_created"
    | "plan_finalized"
    | "chat_message"
    | "error";
  payload: Record<string, unknown>;
  at: string;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: GatewayEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }
}
