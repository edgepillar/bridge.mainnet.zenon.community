/** A local guard refused the request before a wallet was invoked. */
export class NotSubmittedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotSubmittedError'
  }
}
