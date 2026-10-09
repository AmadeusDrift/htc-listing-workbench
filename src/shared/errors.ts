/** Deliberately written business messages that may cross the IPC boundary. */
export class UserFacingError extends Error {
  constructor(message: string) { super(message); this.name = 'UserFacingError'; }
}
