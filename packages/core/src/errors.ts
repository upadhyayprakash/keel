/** A problem the user can fix. Rendered as an error block, with an optional hint line. */
export class KeelError extends Error {
  constructor(
    message: string,
    public hint?: string,
    /** The input it is about (`plan`, `dueOn`, `steps`), so a form can show it there. */
    public field?: string,
  ) {
    super(message);
    this.name = 'KeelError';
  }
}

/**
 * A guarded write found the row changed since it was read (ADR 0003): another device
 * got there first. Nothing in the batch was applied. Commands re-read and say what happened.
 */
export class Conflict extends KeelError {
  constructor(message = 'This changed on another device first, so nothing was saved.', hint = 'Look again and retry if it still applies.') {
    super(message, hint);
    this.name = 'Conflict';
  }
}

/** The item asked for doesn't exist (or was deleted). */
export class NotFound extends KeelError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'NotFound';
  }
}
