import { google } from 'googleapis';
import { config } from '../config.ts';
import type { AgentGoogle } from '../agents/crm.ts';
import { buildRaw } from './gmailRaw.ts';

/**
 * Envoi via l'API Gmail DEPUIS la boîte de l'agent (users.messages.send),
 * en utilisant son refresh token OAuth (connexion in-app ou CRM).
 */
export async function envoyerViaGmailAgent(
  agent: AgentGoogle,
  msg: { to: string; subject: string; html: string; text: string; unsubscribeUrl: string },
): Promise<{ messageId: string }> {
  const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2.setCredentials({ refresh_token: agent.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const resp = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRaw({ fromName: agent.nom, fromEmail: agent.email, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, unsubscribeUrl: msg.unsubscribeUrl }) },
  });
  const id = resp.data.id;
  if (!id) throw new Error('Gmail : réponse sans messageId');
  return { messageId: id };
}
