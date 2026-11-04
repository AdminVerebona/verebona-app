/**
 * Anciennes adresses des CGUV de l'application → site public (lot 102B).
 *
 * L'application ne sert plus de texte juridique comme source :
 *   · `/cgvu`, `/cguv`, `/api/legal/cgvu/current` → URL publique officielle ;
 *   · `/…/versions/<code>` → permalien PUBLIC de cette version (jamais une
 *     autre version : §16.3 maintenu) ;
 *   · exception d'historique : une version publiée par l'ANCIENNE mécanique
 *     (APP_LEGACY), pas encore republiée par le site, reste consultable telle
 *     qu'elle a été figée et acceptée (octets identiques, empreinte vérifiable)
 *     — c'est une ARCHIVE de preuve, marquée comme telle, plus une source.
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { cguvVersionPath, isCguvVersionCode } from '@/lib/legal/public-legal';
import { renderLegalErrorPage } from './legal-error-page';
import { getVersionByCode } from './legal-versions.service';
import { publicSiteBase } from './cguv-manifest';
import { getLegalLinksMode, hasVerifiedPublicLink, serverLegalUrl, versionProofInfo } from './cguv-referential.service';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Redirection vers l'URL publique officielle des CGUV — adresse ACTUELLE du
 * site (`/cgu`) tant que le manifeste n'a pas été lu, `/legal/cguv` ensuite.
 */
export async function redirectToPublicCguv(): Promise<NextResponse> {
  return NextResponse.redirect(await serverLegalUrl('cguv'), { status: 307, headers: NO_STORE });
}

export type VersionTarget =
  | { kind: 'redirect'; url: string }
  | { kind: 'archive'; html: string; versionCode: string }
  | { kind: 'invalid' }
  /** Code jamais vu, site public pas encore livré : pas de lien vers une page qui n'existe pas. */
  | { kind: 'unknown' };

/** Cible d'une version (pur côté décision, lit la base). */
export async function resolveCguvVersionTarget(code: string): Promise<VersionTarget> {
  await ensureMigrations();
  const found = await getVersionByCode(code);
  const siteDelivered = (await getLegalLinksMode()) === 'v2';
  if (found) {
    // Lot 104A (P1-D) : archive non rattachée, ou rattachée avec une empreinte
    // publique différente de l'empreinte historique → l'archive d'origine.
    if (found.source === 'APP_LEGACY' && !hasVerifiedPublicLink(found)) {
      if (found.htmlContent) return { kind: 'archive', html: found.htmlContent, versionCode: found.versionCode };
      return siteDelivered ? { kind: 'redirect', url: `${publicSiteBase()}${cguvVersionPath(found.versionCode)}` } : { kind: 'unknown' };
    }
    return { kind: 'redirect', url: versionProofInfo(found).permalinkUrl };
  }
  if (!isCguvVersionCode(code)) return { kind: 'invalid' };
  // Code jamais vu ici : le site public répond — seulement s'il a livré son archive.
  return siteDelivered ? { kind: 'redirect', url: `${publicSiteBase()}${cguvVersionPath(code)}` } : { kind: 'unknown' };
}

/** Réponse HTTP pour une version (pages et API). */
export async function respondCguvVersion(code: string, opts: { download?: boolean } = {}): Promise<NextResponse> {
  let target: VersionTarget;
  try {
    target = await resolveCguvVersionTarget(code);
  } catch (e) {
    console.error('[legal] résolution de version impossible :', (e as Error).message);
    // Jamais de repli vers une autre version : le permalien public du code.
    target = isCguvVersionCode(code) ? { kind: 'unknown' } : { kind: 'invalid' };
  }
  if (target.kind === 'redirect') return NextResponse.redirect(target.url, { status: 307, headers: NO_STORE });
  // Lot 108L : lien « version en vigueur » de la page d'erreur = site public (jamais /cguv de l'app).
  const currentUrl = target.kind === 'archive' ? null : await serverLegalUrl('cguv').catch(() => null);
  if (target.kind === 'unknown') {
    return new NextResponse(
      renderLegalErrorPage({
        title: 'Version introuvable',
        message: "Aucune version des CGUV ne porte cet identifiant. Elle ne sera jamais remplacée par une autre version : si ce lien vous a été transmis, contactez-nous.",
        requestedVersion: code,
        offerCurrentLink: true,
        currentUrl,
      }),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } },
    );
  }
  if (target.kind === 'invalid') {
    return new NextResponse(
      renderLegalErrorPage({
        title: 'Version introuvable',
        message: "L'identifiant de version indiqué n'a pas le format attendu (AAAA-MM-JJ-vN). Vérifiez le lien que vous avez suivi.",
        requestedVersion: code,
        offerCurrentLink: true,
        currentUrl,
      }),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE } },
    );
  }
  return new NextResponse(target.html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Legal-Version': target.versionCode,
      // Archive de preuve d'une version antérieure au lot 102B : le site public fait foi.
      'X-Legal-Source': 'archive-historique',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      ...(opts.download ? { 'Content-Disposition': `attachment; filename="CGUV_Verebona_${target.versionCode.replace(/[^\w.-]/g, '_')}.html"` } : {}),
    },
  });
}
