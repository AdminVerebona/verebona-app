/**
 * GET /cgvu/versions/{version} — permalien d'une version figée (CDC 7 §3.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE PERMALIEN NE REDIRIGE JAMAIS
 *
 * C'est l'exigence centrale du dispositif. Le §16.3 l'écrit deux fois — « ne
 * jamais rediriger silencieusement vers une version plus récente » — et le
 * scénario R05 la vérifie explicitement. Un permalien qui afficherait autre
 * chose que ce qu'il désigne priverait de toute valeur le lien envoyé par
 * email après souscription : le consommateur ne pourrait plus consulter les
 * stipulations qu'il a effectivement acceptées.
 *
 * Version inconnue ou contenu absent → page d'erreur explicite, jamais un
 * autre document.
 *
 * ⚠️ Cette page reste accessible après fermeture du compte (§12, R07). Elle ne
 * lit ni session ni cookie, et ne contient aucune donnée personnelle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getVersionByCode, isValidVersionCode } from '@/services/legal';
import { renderLegalErrorPage } from '@/services/legal/legal-error-page';

export const dynamic = 'force-dynamic';

function errorResponse(status: number, body: string) {
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const { version } = await params;

  if (!isValidVersionCode(version)) {
    return errorResponse(
      404,
      renderLegalErrorPage({
        title: 'Version introuvable',
        message:
          "L'identifiant de version indiqué n'a pas le format attendu " +
          '(AAAA-MM-JJ-vN). Vérifiez le lien que vous avez suivi.',
        requestedVersion: version,
        offerCurrentLink: true,
      }),
    );
  }

  await ensureMigrations();
  const found = await getVersionByCode(version);

  if (!found) {
    return errorResponse(
      404,
      renderLegalErrorPage({
        title: 'Version introuvable',
        message:
          "Aucune version publiée ne porte cet identifiant. Si ce lien vous a " +
          'été transmis par email, contactez-nous : il ne sera jamais remplacé ' +
          'par une autre version.',
        requestedVersion: version,
        offerCurrentLink: true,
      }),
    );
  }

  if (!found.htmlContent) {
    // §18, « fichier versionné indisponible » : erreur spécifique et alerte.
    console.error(
      `[legal] contenu absent pour la version publiée ${version} — ` +
      'restauration depuis la sauvegarde requise, empreinte à vérifier avant remise en ligne.',
    );
    return errorResponse(
      503,
      renderLegalErrorPage({
        title: 'Version temporairement indisponible',
        message:
          'Cette version existe mais son contenu ne peut pas être servi ' +
          'actuellement. Nos équipes en sont informées. Elle ne sera pas ' +
          'remplacée par une autre version.',
        requestedVersion: version,
      }),
    );
  }

  return new NextResponse(found.htmlContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Le contenu est figé à vie : il peut être mis en cache sans limite.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Legal-Version': found.versionCode,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}
