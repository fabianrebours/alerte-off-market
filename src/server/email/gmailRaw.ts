/** Construit un message MIME multipart encodé base64url pour l'API Gmail. */

const aDuNonAscii = (s: string) => /[^\x00-\x7F]/.test(s);

/**
 * Encode un texte d'en-tête en « encoded-words » RFC 2047, découpés pour que
 * chaque mot encodé reste ≤ 75 octets (sinon certains MTA tronquent/rejettent).
 * On découpe par point de code pour ne jamais casser un caractère multi-octets.
 */
function encodeEntete(s: string): string {
  if (!aDuNonAscii(s)) return s;
  const mots: string[] = [];
  let courant = '';
  for (const ch of s) {
    const tentative = courant + ch;
    // 45 octets de charge utile → ~60 car. en base64 + 12 d'enrobage ≤ 75.
    if (Buffer.byteLength(tentative, 'utf8') > 45) {
      if (courant) mots.push(courant);
      courant = ch;
    } else {
      courant = tentative;
    }
  }
  if (courant) mots.push(courant);
  return mots.map((m) => `=?UTF-8?B?${Buffer.from(m, 'utf8').toString('base64')}?=`).join(' ');
}

/** Corps base64 plié à 76 caractères par ligne (RFC 2045). */
function base64Plie(s: string): string {
  return (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

export function buildRaw(opts: {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  replyTo?: string;
}): string {
  const from = `${encodeEntete(opts.fromName)} <${opts.fromEmail}>`;
  const subject = encodeEntete(opts.subject.replace(/[\r\n]+/g, ' ')); // anti-injection d'en-tête
  // Frontière sans caractère de l'alphabet base64 (« _ ») → jamais présente dans le corps encodé.
  const boundary = `__mtr_${Buffer.from(opts.to).toString('hex').slice(0, 20)}__`;

  const entetes = [
    `From: ${from}`,
    `To: ${opts.to}`,
    opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    // Désinscription un-clic (RFC 8058) — quasi obligatoire pour le cold-mail B2C.
    `List-Unsubscribe: <${opts.unsubscribeUrl}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const corps = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Plie(opts.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Plie(opts.html),
    `--${boundary}--`,
    '',
  ];

  const message = [...entetes, '', ...corps].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}
