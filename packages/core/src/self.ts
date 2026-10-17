/** `@me` is the reserved handle for the user: promises they make to themselves. */
export const SELF = 'me';

export function isSelf(handle: string): boolean {
  return handle === SELF;
}

/** "I owe Ravi", "for myself" or "waiting on Meera". */
export function whoPhrase(direction: 'owe' | 'wait', handle: string, name: string): string {
  if (direction === 'wait') return `waiting on ${name}`;
  return isSelf(handle) ? 'for myself' : `I owe ${name}`;
}

/** The other side of a promise in arrow form: "Ravi", or "myself" for @me. */
export function whoName(handle: string, name: string): string {
  return isSelf(handle) ? 'myself' : name;
}
