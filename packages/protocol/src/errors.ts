/** Errors that are safe to expose at the session protocol boundary. */
export class SessionRequestError extends Error {
  readonly code = "invalid_request"
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "SessionRequestError"
    this.status = status
  }
}

export function isSessionRequestError(error: unknown): error is SessionRequestError {
  return error instanceof SessionRequestError
}
