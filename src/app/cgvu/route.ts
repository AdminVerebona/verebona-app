/**
 * GET /cgvu — version actuellement en vigueur (CDC 7 §3.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN GESTIONNAIRE DE ROUTE, ET PAS UNE PAGE REACT
 *
 * Le §13 exige que le fichier téléchargé « contienne exactement le même texte
 * que la page ». Une page React reconstruirait le document à chaque rendu :
 * une évolution de la mise en page, un composant partagé modifié, et la page
 * cesserait de correspondre au fichier dont l'empreinte SHA-256 est
 * enregistrée — sans que rien ne le signale.
 *
 * Ici, la page EST le fichier figé. Le même octet est servi à l'affichage et
 * au téléchargement ; seul l'en-tête `Content-Disposition` diffère. Le §16.1
 * le demande d'ailleurs explicitement : « servir le document sans génération
 * dynamique susceptible d'en modifier le contenu ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getCurrentVersion } from '@/services/legal';
import { renderLegalErrorPage } from '@/services/legal/legal-error-page';
import { logDatabaseError } from '@/lib/database-diagnostic';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ensureMigrations();

  let current;
  try {
    current = await getCurrentVersion();
  } catch (e) {
    // §16.3 : « retourner une page explicite en cas d'incident ». Un 500 nu
    // laissait le visiteur — et l'exploitant — sans la moindre indication.
    const { reference } = logDatabaseError('CGVU-PAGE', e);
    return new NextResponse(
      renderLegalErrorPage({
        title: 'Conditions générales indisponibles',
        message:
          'Un incident technique nous empêche de les afficher. Nos équipes en ' +
          `sont informées (référence ${reference}).`,
      }),
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  if (!current?.htmlContent) {
    // §16.3 : « retourner une page explicite en cas d'incident ».
    return new NextResponse(
      renderLegalErrorPage({
        title: 'Conditions générales indisponibles',
        message:
          "Aucune version des conditions générales n'est actuellement publiée. " +
          'Nos équipes en sont informées.',
      }),
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  return new NextResponse(current.htmlContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // La version courante peut changer : pas de cache long.
      'Cache-Control': 'public, max-age=300',
      // Permet de savoir quelle version a été servie sans lire le contenu.
      'X-Legal-Version': current.versionCode,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}
