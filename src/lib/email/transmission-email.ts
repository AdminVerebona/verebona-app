/**
 * E-mail « transmission de bien » — corps HTML de repli quand aucun gabarit
 * `TRANSMISSION_INVITE` n'existe en base (cas courant : aucun amorçage ne le crée).
 *
 * Lot 66C : déplacé de `app/api/assets/[id]/transmission/route.ts` et mis à la
 * charte « Sérénité » 2026 (mise en page commune `email-layout.ts`). Textes, lien et
 * objet inchangés. Les valeurs saisies (nom de l'expéditeur, nom du bien) sont
 * désormais échappées : elles étaient insérées telles quelles dans le HTML.
 */
import { EMAIL_STYLES as S, emailButton, emailCallout, emailDocument, emailLogoHtml, emailAssetBaseUrl } from './email-layout';

const esc = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildTransmissionHtml(senderName: string, assetName: string, shareUrl: string, year: string, baseUrl: string = emailAssetBaseUrl()): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = esc(shareUrl);
  const content = [
    `<p style="${S.p}">Bonjour,</p>`,
    `<p style="${S.p}"><strong>${esc(senderName)}</strong> vous invite à recevoir un bien dans votre portefeuille Verebona :</p>`,
    emailCallout(`<p class="vb-eyebrow" style="${S.eyebrow}">Bien transmis</p><p style="margin:0;font-size:18px;font-weight:700;">${esc(assetName)}</p>`),
    `<p style="${S.p}">Pour accepter ou refuser cette transmission, cliquez sur le bouton ci-dessous.</p>`,
    emailButton(url, "Voir l'invitation"),
    `<p class="vb-muted" style="${S.muted}">Ou copiez ce lien dans votre navigateur :<br/><a class="vb-link" href="${url}" style="${S.linkBreak}">${url}</a></p>`,
    `<p class="vb-muted" style="${S.muted}">Si vous n'attendiez pas cette invitation, vous pouvez l'ignorer.</p>`,
  ].join('\n');
  const footer = `<p class="vb-foot" style="margin:0 0 6px 0;${S.small}">© ${esc(year)} Verebona — One place. Higher value.</p>
<p class="vb-foot" style="margin:0;${S.small}"><a class="vb-link" href="mailto:support@verebona.com" style="${S.link}">support@verebona.com</a></p>`;
  return emailDocument({ title: 'Transmission de bien — Verebona', content, footer, logo: emailLogoHtml(base), baseUrl: base });
}
