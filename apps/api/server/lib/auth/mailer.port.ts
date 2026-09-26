/** An email Better Auth sends: a magic-link sign-in or an account notice. */
export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

/**
 * How the API sends mail (PT-1a item 8, D174b(3)). One adapter over Resend's
 * HTTP API (`ResendMailer`), one that only logs (`LogMailer`, no key
 * configured) — no SDK, `fetch` only, per D174b(3).
 */
export interface MailerPort {
  send(mail: Mail): Promise<void>;
}
