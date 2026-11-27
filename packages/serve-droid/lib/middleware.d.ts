import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface DroidMiddlewareOptions {
  /** Mount path (default `/.droid`). */
  basePath?: string;
  /** serve-droid URL as printed by `serve-droid start`, including any `?token=`. */
  url: string;
}

export interface DroidMiddleware {
  (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void): void;
  /** Call from `server.on('upgrade', ...)`. Returns false when the request is not under basePath. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

export declare function droidMiddleware(options: DroidMiddlewareOptions): DroidMiddleware;
export default droidMiddleware;
