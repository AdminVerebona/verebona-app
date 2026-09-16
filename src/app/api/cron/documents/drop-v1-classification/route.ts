/**
 * GET /api/cron/documents/drop-v1-classification — retrait du classement V1.
 * CDC V2.0 §15.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA SEULE ROUTE DE CE CHANTIER QUI DÉTRUIT
 *
 * Toutes les autres routes cron sont rejouables : au pire, elles refont un
 * travail déjà fait. Celle-ci supprime des colonnes et des tables. Un retour
 * arrière de déploiement ne la rattrape pas — le code revient, les données non.
 *
 * Elle est donc protégée à trois niveaux, et c'est volontairement lourd :
 *
 *   1. `CRON_SECRET`, comme toute route cron ;
 *   2. un mot de passe d'action, `?confirm=SUPPRIMER-CLASSEMENT-V1`, qui ne
 *      peut pas être tapé par erreur ni deviné par un appel de routine ;
 *   3. un contrôle métier : le retrait est REFUSÉ tant qu'un document classé
 *      en V1 n'a pas d'équivalent V2.
 *
 * Le troisième est le plus important. Supprimer la colonne avec un reste non
 * nul perdrait le classement de ces documents sans recours : la Rubrique ne
 * serait plus déductible de rien.
 *
 * ── SANS `confirm`, ELLE NE FAIT QUE REGARDER ─────────────────────────────
 *
 * L'appel nu rend l'état du parc et s'arrête là. C'est le comportement par
 * défaut, pas une option : une route destructrice dont l'appel le plus simple
 * détruit finit par être appelée « pour voir ».
 *
 *   GET …/drop-v1-classification                              → état du parc
 *   GET …/drop-v1-classification?confirm=SUPPRIMER-CLASSEMENT-V1  → exécution
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient, ensureMigrations } from '@/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Mot de passe d'action. Distinct du secret cron, et volontairement explicite. */
const CONFIRMATION = 'SUPPRIMER-CLASSEMENT-V1';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  // ── 1. État du parc ─────────────────────────────────────────────────────
  const rows = (await pgClient.unsafe(
    `SELECT COALESCE(SUM(a_retraiter), 0)::int      AS a_retraiter,
            COALESCE(SUM(version_obsolete), 0)::int AS version_obsolete,
            COALESCE(SUM(total), 0)::int            AS total,
            COALESCE(SUM(classes_v2), 0)::int       AS classes_v2
       FROM v2_classification_progress`,
  )) as unknown as Array<{
    a_retraiter: number;
    version_obsolete: number;
    total: number;
    classes_v2: number;
  }>;

  const parc = rows[0] ?? { a_retraiter: 0, version_obsolete: 0, total: 0, classes_v2: 0 };
  const confirme = req.nextUrl.searchParams.get('confirm') === CONFIRMATION;

  // ── 2. Contrôle métier, avant toute chose ───────────────────────────────
  if (parc.a_retraiter > 0) {
    return NextResponse.json(
      {
        refuse: true,
        raison: `${parc.a_retraiter} document(s) classés en V1 sans équivalent V2.`,
        remede:
          'Lancer /api/cron/documents/referential-upgrade jusqu’à ce que ce nombre ' +
          'atteigne 0, puis rappeler cette route.',
        parc,
      },
      { status: 409 },
    );
  }

  // ── 3. Sans confirmation : lecture seule ────────────────────────────────
  if (!confirme) {
    return NextResponse.json({
      execute: false,
      parc,
      message:
        'Contrôle passé, rien n’a été supprimé. Faites une SAUVEGARDE de la base, ' +
        `puis rappelez cette route avec ?confirm=${CONFIRMATION}`,
      aSupprimerEnsuite: FICHIERS_A_RETIRER,
    });
  }

  // ── 4. Retrait ──────────────────────────────────────────────────────────
  //
  // Les colonnes d'abord, les tables ensuite : l'inverse échouerait sur les
  // clés étrangères et laisserait le schéma à moitié migré — l'état le plus
  // difficile à diagnostiquer.
  await pgClient.unsafe(`
    ALTER TABLE asset_files
      DROP COLUMN IF EXISTS document_category_id,
      DROP COLUMN IF EXISTS classification_state,
      DROP COLUMN IF EXISTS category_confidence,
      DROP COLUMN IF EXISTS type_confidence,
      DROP COLUMN IF EXISTS category_source,
      DROP COLUMN IF EXISTS type_source,
      DROP COLUMN IF EXISTS category_user_locked,
      DROP COLUMN IF EXISTS type_user_locked;
  `);

  await pgClient.unsafe(`
    DROP TABLE IF EXISTS document_category_type_associations;
    DROP TABLE IF EXISTS document_category_asset_associations;
    DROP TABLE IF EXISTS document_categories CASCADE;
  `);

  return NextResponse.json({
    execute: true,
    parc,
    message: 'Classement V1 retiré de la base.',
    aSupprimerEnsuite: FICHIERS_A_RETIRER,
  });
}

/**
 * Le ménage du CODE reste manuel.
 *
 * Ces fichiers s'importent les uns les autres : les supprimer sans revue
 * casserait la compilation à des endroits que la liste ne montre pas. La route
 * les rappelle plutôt que de prétendre s'en charger.
 */
const FICHIERS_A_RETIRER = [
  'src/services/documents/classification-rules.ts',
  'src/services/documents/classification.service.ts',
  'src/services/documents/reclassify.service.ts',
  'src/services/ai/source-analysis/steps/classify-category.step.ts',
  'src/db/seeds/documents/',
  'src/app/api/admin/document-categories/',
  'src/app/(dashboard)/documents/classement/',
  'src/services/to-process.service.ts (et src/types/to-process.ts)',
];
