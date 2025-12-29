/**
 * Custom error classes for specific error handling
 */

// V8-specific captureStackTrace (available in Node.js and Chrome)
declare global {
  interface ErrorConstructor {
    captureStackTrace?(targetObject: object, constructorOpt?: NewableFunction): void
  }
}

/**
 * Error thrown when input validation fails
 * Use this for user-facing validation errors that should be re-thrown as-is
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    // Fix prototype chain for instanceof to work reliably (esp. ES5 targets)
    Object.setPrototypeOf(this, ValidationError.prototype)
    this.name = 'ValidationError'
    // Capture stack trace if available (V8 environments)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ValidationError)
    }
  }
}
