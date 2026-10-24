// Errors whose message is fixed text written here, safe to show: it names a setting or a
// secret, never a value, a response body or a database message.

/** The server cannot start, or a check of ui-check failed. */
export class StartError extends Error {
  override name = "StartError";
}

/** The database refused a query. Only the SQLSTATE code is kept, never the message. */
export class DbError extends Error {
  override name = "DbError";
  readonly code: string;

  constructor(code: string) {
    super(`The database refused a query (code ${code || "unknown"})`);
    this.code = code;
  }
}
