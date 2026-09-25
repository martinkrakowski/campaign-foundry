import type { Mail, MailerPort } from "./mailer.port.js";

/**
 * The mailer when no `RESEND_API_KEY` is configured: logs instead of sending,
 * so `AUTH_MODE=better-auth` still boots (with mail visible on the console
 * for local sign-in) rather than refusing for want of a key it does not need
 * to serve `local` at all.
 */
export class LogMailer implements MailerPort {
  async send(mail: Mail): Promise<void> {
    console.log(`[auth] no RESEND_API_KEY set — would send to ${mail.to}: ${mail.subject}`);
  }
}
