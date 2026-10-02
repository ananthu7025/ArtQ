// Email transports. Production uses a provider that honours an idempotency key (architecture.md §1: Resend or SES), so a
// job retried after the provider accepted the message does not send it twice. SMTP (Mailpit locally) has no such key.
import nodemailer, { type Transporter } from 'nodemailer';

export type OutgoingEmail = { from: string; to: string; subject: string; text: string; html: string; idempotencyKey: string };

export class EmailSendError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); this.name = 'EmailSendError'; }
}

export interface EmailTransport {
  readonly name: string;
  send(m: OutgoingEmail): Promise<{ messageId: string }>;
}

export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly t: Transporter;
  constructor(o: { host: string; port: number; secure?: boolean; user?: string; pass?: string }) {
    this.t = nodemailer.createTransport({
      host: o.host, port: o.port, secure: o.secure ?? false,
      ...(o.user ? { auth: { user: o.user, pass: o.pass ?? '' } } : {}),
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
  }
  async send(m: OutgoingEmail) {
    try {
      const info = await this.t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: { 'X-Idempotency-Key': m.idempotencyKey } });
      return { messageId: String(info.messageId) };
    } catch (e) {
      throw new EmailSendError(`smtp: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
}

/** Resend HTTP API (POST /emails) with the `Idempotency-Key` header (keys are honoured for 24 hours). */
export class ResendTransport implements EmailTransport {
  readonly name = 'resend';
  constructor(private readonly o: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {}
  async send(m: OutgoingEmail) {
    const f = this.o.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.o.baseUrl ?? 'https://api.resend.com'}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey },
        body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new EmailSendError(`resend: ${e instanceof Error ? e.message : String(e)}`, true);   // network/timeout: retry with the same key
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (res.ok && body.id) return { messageId: body.id };
    const retryable = res.status === 429 || res.status >= 500;
    throw new EmailSendError(`resend ${res.status}: ${body.name ?? ''} ${body.message ?? ''}`.trim(), retryable);
  }
}

/** Records messages in memory (tests); `failNext` makes the next sends fail. */
export class MemoryTransport implements EmailTransport {
  readonly name = 'memory';
  readonly sent: (OutgoingEmail & { messageId: string })[] = [];
  failNext = 0;
  async send(m: OutgoingEmail) {
    if (this.failNext > 0) { this.failNext--; throw new EmailSendError('memory: simulated failure', true); }
    const messageId = `mem-${this.sent.length + 1}`;
    this.sent.push({ ...m, messageId });
    return { messageId };
  }
}
