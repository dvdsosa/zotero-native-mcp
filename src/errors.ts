/**
 * Error types carrying agent-actionable remediation text.
 *
 * Every message is written for an LLM caller: it says what failed and what
 * the next call should be, rather than just restating the HTTP status.
 */

export class ZoteroError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ZoteroError';
  }

  /** Full text handed back to the model, message plus remediation. */
  toToolText(): string {
    return this.hint ? `${this.message}\n\n${this.hint}` : this.message;
  }
}

/** A non-2xx response from Zotero's local API. */
export class ZoteroHttpError extends ZoteroError {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
    hint?: string,
  ) {
    super(message, hint);
    this.name = 'ZoteroHttpError';
  }
}

/** Zotero is unreachable: not running, or the local API is switched off. */
export class ZoteroUnreachableError extends ZoteroError {
  constructor(baseUrl: string, cause: string) {
    super(
      `Cannot reach Zotero's local API at ${baseUrl} (${cause}).`,
      [
        'Checklist for the user:',
        '  1. Zotero 7.1 or newer must be running (Zotero 10 recommended).',
        '  2. Settings -> Advanced -> "Allow other applications on this computer to',
        '     communicate with Zotero" must be enabled.',
        '  3. If Zotero listens on a non-default port, set ZOTERO_LOCAL_PORT.',
        'Call zotero_status once Zotero is up to confirm the connection.',
      ].join('\n'),
    );
    this.name = 'ZoteroUnreachableError';
  }
}

/** The user pressed "Deny" in Zotero's authorization dialog. */
export class ZoteroAuthorizationDeniedError extends ZoteroError {
  constructor() {
    super(
      'The user denied write access in Zotero\'s authorization dialog.',
      'Do not retry automatically. Tell the user that write tools stay unavailable ' +
        'until they approve the request, and let them re-run zotero_authorize when ready.',
    );
    this.name = 'ZoteroAuthorizationDeniedError';
  }
}

/** Local-only input validation, caught before any HTTP call is made. */
export class ZoteroInputError extends ZoteroError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'ZoteroInputError';
  }
}
