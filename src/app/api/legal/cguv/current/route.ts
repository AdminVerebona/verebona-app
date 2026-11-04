/**
 * GET /api/legal/cguv/current — public (lot 102B).
 *
 * Métadonnées de la version des CGUV en vigueur, SANS texte : code, permalien
 * public, empreinte SHA-256, décision « substantielle », dates, et les URL
 * publiques officielles des cinq contenus légaux. Le formulaire d'inscription
 * enregistre la version effectivement présentée (§18).
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { logDatabaseError } from '@/lib/database-diagnostic';
import { getPublicCurrentCguv, getServerLegalLinks, serverLegalLinks } from '@/services/legal/cguv-referential.service';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Adresses actuelles du site tant qu'il n'a pas livré, /legal/… ensuite.
  const [{ mode, links: resolved }, links] = await Promise.all([getServerLegalLinks(), serverLegalLinks()]);
  const publicUrl = resolved.cguv;
  let current;
  try {
    await ensureMigrations();
    current = await getPublicCurrentCguv();
  } catch (e) {
    const { reference } = logDatabaseError('CGUV', e);
    return NextResponse.json(
      { error: 'Les CGUV sont momentanément indisponibles.', code: 'LEGAL_UNAVAILABLE', reference, publicUrl, links },
      { status: 503 },
    );
  }
  if (!current) {
    return NextResponse.json({ error: 'Aucune version des CGUV n’est connue.', code: 'NO_CURRENT_VERSION', publicUrl, links }, { status: 503 });
  }
  return NextResponse.json({
    versionCode: current.versionCode,
    title: current.title,
    effectiveAt: current.effectiveAt,
    publishedAt: current.publishedAt,
    changeSummary: current.changeSummary,
    requiresReacceptance: current.requiresReacceptance,
    // Lot 108L : URL PUBLIQUE de la version exacte (site de l'environnement),
    // `null` si son texte n'est pas vérifié sur le site public — jamais app.* ni
    // /cgvu, jamais une autre version. `publicText` : état explicite affiché par
    // les formulaires (acceptation refusée tant que « NOT_ON_PUBLIC_SITE »).
    permalink: current.permalinkUrl,
    permalinkUrl: current.permalinkUrl,
    publicText: current.publicText,
    sha256: current.sha256,
    publicUrl,
    links,
    linksMode: mode,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
