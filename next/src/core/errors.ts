/** Typed errors with stable codes. They reach hosts as JSON-RPC errors (§15). */
export type ErrorCode =
  | 'session_not_found'
  | 'session_exists'
  | 'session_exited'
  | 'run_not_found'
  | 'busy'
  | 'not_controller'
  | 'forbidden'
  | 'invalid_argument'
  | 'unsupported'
  | 'backend_failure'
  | 'timeout'
  /** Another live daemon holds the data dir's lock (termd.lock): two daemons must never share journals (G10). */
  | 'data_dir_locked';

export class TermError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TermError';
  }
}

export const err = (code: ErrorCode, message: string, data?: Record<string, unknown>): TermError =>
  new TermError(code, message, data);
