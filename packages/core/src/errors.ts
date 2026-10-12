/** A problem the user can fix. Rendered as an error block, with an optional hint line. */
export class KeelError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'KeelError';
  }
}
