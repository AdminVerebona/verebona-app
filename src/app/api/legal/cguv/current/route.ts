/**
 * GET /api/legal/cguv/current — public (lot 102B).
 *
 * Métadonnées de la version des CGUV en vigueur, SANS texte : code, permalien
 * public, empreinte SHA-256, décision « substantielle », dates, et les URL
 * publiques officielles des cinq contenus légaux. Le formulaire d'inscription
 * enregistre la version effectivement présentée (§18).
 *
 * Lot 111O — reprise fiable : tant que la version en vigueur n'est pas
 * acceptable (texte non vérifié sur le site public), chaque ouverture /
 * relecture d'un formulaire d'inscription relance la lecture du manifeste
 * (au plus une fois par intervalle, attente bornée — `refreshCguvIfBlocked`),
 * puis la version est RELUE en base : jamais de version mise en cache, jamais
 * de substitution. Toutes les réponses sont `no-store`.
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { logDatabaseError } from '@/lib/database-diagnostic';
import { getPublicCurrentCguv, getServerLegalLinks, serverLegalLinks } from '@/services/legal/cguv-referential.service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  let current;
  try {
    await ensureMigrations();
    current = await getPublicCurrentCguv();
    if (!current || current.publicText !== 'VERIFIED') {
      const { refreshCguvIfBlocked } = await import('@/services/legal/cguv-publication-diagnostic');
      if ((await refreshCguvIfBlocked()) === 'refreshed') current = await getPublicCurrentCguv();
    }
  } catch (e) {
    const { reference } = logDatabaseError('CGUV', e);
    const [{ links: resolved }, links] = await Promise.all([getServerLegalLinks(), serverLegalLinks()]);
    return NextResponse.json(
      { error: 'Les CGUV sont momentanément indisponibles.', code: 'LEGAL_UNAVAILABLE', reference, publicUrl: resolved.cguv, links },
      { status: 503, headers: NO_STORE },
    );
  }
  // Liens résolus APRÈS l'éventuelle relecture (bascule /legal/… comprise).
  const [{ mode, links: resolved }, links] = await Promise.all([getServerLegalLinks(), serverLegalLinks()]);
  const publicUrl = resolved.cguv;
  if (!current) {
    return NextResponse.json({ error: 'Aucune version des CGUV n’est connue.', code: 'NO_CURRENT_VERSION', publicUrl, links }, { status: 503, headers: NO_STORE });
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
    // Lot 111O : objet résolu (clé → URL) — « Confidentialité » du formulaire lu ici, au même instant.
    legalLinks: resolved,
    linksMode: mode,
  }, { headers: NO_STORE });
}
