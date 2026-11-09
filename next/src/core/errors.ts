export type ErrorCode = 'invalid_argument' | 'backend_failure';

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

export const clause = (message: string): string => message.replace(/\.$/, '');
