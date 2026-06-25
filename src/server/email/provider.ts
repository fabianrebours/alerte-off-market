import { config } from '../config.ts';

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  replyTo?: string | null;
}

/**
 * Envoi via Resend (https://api.resend.com/emails) — même approche que
 * server-crm-immo/src/modules/audit/adapters/notifications.adapter.ts (fetch, pas de SDK).
 * `reply_to` = email de l'agent → les réponses lui arrivent directement.
 */
export async function envoyerViaResend(input: SendInput): Promise<{ messageId: string }> {
  if (!config.resend.apiKey) throw new Error('RESEND_API_KEY non configuré');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.resend.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: input.replyTo || undefined,
      headers: {
        'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Resend ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { id?: string };
  return { messageId: data.id ?? '' };
}
