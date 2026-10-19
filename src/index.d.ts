import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";

export interface GracefulOptions {
  server: Server | HttpsServer;
  /** Run one by one after the server has stopped, for example closing the database. */
  hooks?: Array<() => void | Promise<void>>;
  /** Total time for the drain, the running requests and the hooks. Default 10000. */
  timeoutMs?: number;
  /** Wait this long after readiness turns to "shutting down" before the server stops. Default 0. Must be less than timeoutMs (RangeError). */
  drainMs?: number;
  /** Default: SIGTERM and SIGINT. */
  signals?: string[];
  log?: (message: string) => void;
  proc?: Pick<NodeJS.Process, "on" | "off">;
  exit?: (code: number) => void;
}

export interface ShutdownResult {
  /** 0 when everything finished cleanly, 1 when something had to be forced or failed. */
  code: number;
  forced: boolean;
}

export interface Graceful {
  shutdown(reason?: string): Promise<ShutdownResult>;
  isShuttingDown(): boolean;
  readiness(req: IncomingMessage, res: ServerResponse): void;
  dispose(): void;
}

export function gracefulShutdown(options: GracefulOptions): Graceful;
