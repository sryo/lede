// An error whose message is meant for the person using the dashboard, sent back with its HTTP status.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
