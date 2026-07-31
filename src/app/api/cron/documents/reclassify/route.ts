/**
 * GET /api/cron/documents/reclassify — CDC 5 §4.3 règle 1, §7.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE ROUTE ET NON UN SCRIPT
 *
 * La base de préproduction n'est pas joignable depuis un poste : l'accès
 * Internet y est fermé, et c'est très bien ainsi. Un script `npm` suppose au
 * contraire de l'ouvrir, de copier une URL, d'y placer un mot de passe — et de
 * refaire tout cela à chaque rotation de ce mot de passe.
 *
 * Le serveur, lui, a déjà la connexion. Une route l'emprunte.
 *
 * Le script `scripts/reclassify-documents.ts` reste disponible pour un poste
 * de développement, où la base est locale.
 *
 * ── PARAMÈTRES ────────────────────────────────────────────────────────────
 *
 *   ?dryRun=1        rapporte sans écrire — À FAIRE EN PREMIER
 *   ?account=42      limite la reprise à un compte
 *   ?limit=1000      plafond de documents examinés
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, db } from '@/db';
import { documentCategories, documentCategoryTypeAssociations } from '@/db/schema';
import { sql } from 'drizzle-orm';
import {
  reclassifyUnclassifiedDocuments,
  classificationCounts,
} from '@/services/documents/reclassify.service';

export const dynamic = 'force-dynamic';
/** Une reprise volumineuse dépasse le délai par défaut. */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const p = req.nextUrl.searchParams;
  const dryRun = p.get('dryRun') === '1';
  const accountId = Number(p.get('account')) || undefined;
  const limit = Number(p.get('limit')) || undefined;

  // ── Le référentiel est-il amorcé ? ──────────────────────────────────────
  //
  // Sans catégories ni associations, la reprise ne peut rien déduire : elle
  // rendrait « 0 classé » sans que rien n'explique pourquoi. Mieux vaut le
  // dire que laisser conclure à un échec du traitement.
  const [refCategories] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentCategories);
  const [refAssociations] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentCategoryTypeAssociations);

  if ((refCategories?.n ?? 0) === 0 || (refAssociations?.n ?? 0) === 0) {
    return NextResponse.json(
      {
        error: 'Référentiel de classement non amorcé.',
        code: 'REFERENTIAL_EMPTY',
        categories: refCategories?.n ?? 0,
        associations: refAssociations?.n ?? 0,
        remede: 'Exécuter npm run db:seed:doc-categories avant cette reprise.',
      },
      { status: 409 },
    );
  }

  const avant = await classificationCounts(accountId);
  const rapport = await reclassifyUnclassifiedDocuments({ accountId, dryRun, limit });
  const apres = dryRun ? avant : await classificationCounts(accountId);

  return NextResponse.json({
    dryRun,
    referentiel: { categories: refCategories.n, associations: refAssociations.n },
    avant,
    apres,
    rapport,
    // Ce qui reste après cette reprise relève du traitement de cohérence par
    // l'IA (§7.2), qui suppose la bascule de AI_UNIFIED_SOURCE_ANALYSIS.
    resteAuTraitementIA: apres.toClassify,
  });
}
