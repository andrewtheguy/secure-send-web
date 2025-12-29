/**
 * Custom error classes for specific error handling
 */

/**
 * Error thrown when input validation fails
 * Use this for user-facing validation errors that should be re-thrown as-is
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
