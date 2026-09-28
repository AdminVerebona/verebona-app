/**
 * Notification du support après l'échec d'une génération d'export.
 *
 * L'ancienne fonction `sendSupportEmail` n'envoyait rien (TODO + console) alors
 * que `error_payload.supportEmailSent` était forcé à `true` : l'historique
 * affirmait un envoi qui n'avait jamais eu lieu.
 *
 * L'e-mail est désormais réellement envoyé via Resend (même fournisseur et
 * même expéditeur que les autres e-mails applicatifs, cf. transmission) à
 * l'adresse `SUPPORT_EMAIL`. Sans adresse ou sans clé Resend configurée,
 * aucun envoi n'est tenté : l'échec est journalisé et la fonction renvoie
 * `false` — le payload enregistre alors `supportEmailSent: false`.
 *
 * Il s'agit d'un e-mail interne : il ne contient que des identifiants et le
 * message technique, jamais de données personnelles du bien.
 */

import { Resend } from 'resend';

export interface ExportFailureNotification {
  assetId: number;
  exportId: number;
  exportType: string;
  technicalMessage: string;
  attemptCount: number;
  userId: number;
  accountId: number;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Adresse du support, ou `null` si non configurée. */
export function getSupportEmailAddress(): string | null {
  const value = process.env.SUPPORT_EMAIL?.trim();
  return value ? value : null;
}

/**
 * Envoie la notification au support. Ne lève jamais : renvoie `true`
 * seulement si le fournisseur a accepté l'envoi.
 */
export async function notifySupportOfExportFailure(params: ExportFailureNotification): Promise<boolean> {
  const to = getSupportEmailAddress();
  const apiKey = process.env.RESEND_API_KEY;
  if (!to || !apiKey) {
    console.error('[ExportSupport] Notification support non envoyée (SUPPORT_EMAIL ou RESEND_API_KEY absent) :', params);
    return false;
  }

  const lines: Array<[string, string]> = [
    ['Export', `#${params.exportId}`],
    ['Type', params.exportType],
    ['Bien', `#${params.assetId}`],
    ['Compte', `#${params.accountId}`],
    ['Utilisateur', `#${params.userId}`],
    ['Tentative', String(params.attemptCount)],
    ['Erreur technique', params.technicalMessage],
  ];
  const text = ['Échec de génération d’un export Verebona.', '', ...lines.map(([k, v]) => `${k} : ${v}`)].join('\n');
  const html = `<p>Échec de génération d’un export Verebona.</p><ul>${
    lines.map(([k, v]) => `<li><strong>${escapeHtml(k)}</strong> : ${escapeHtml(v)}</li>`).join('')
  }</ul>`;

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: 'Verebona <noreply@verebona.com>',
      to,
      subject: `[Exports] Échec de génération — export #${params.exportId} (${params.exportType})`,
      text,
      html,
    });
    if (error) {
      console.error('[ExportSupport] Envoi refusé par le fournisseur :', error, params);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ExportSupport] Envoi impossible :', err, params);
    return false;
  }
}
