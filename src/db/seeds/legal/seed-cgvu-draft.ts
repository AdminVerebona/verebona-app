/**
 * Crée le BROUILLON des CGVU du 25/09/2026 (médiation de la consommation).
 *
 * Ne publie rien : la publication (et le choix d'exiger ou non une nouvelle
 * acceptation) se fait depuis l'administration des documents légaux.
 * Idempotent : relancé, il ne crée pas de doublon.
 *
 *   npm run db:seed:cgvu-draft
 */
// ⚠️ EN PREMIER : `@/db` lit DATABASE_URL au chargement du module.
import '@/lib/load-env';
import { ensureMigrations } from '@/db';
import { createDraft, getVersionByCode, LEGAL_DOCUMENT_LABEL } from '@/services/legal';
import {
  CGVU_2026_09_25_VERSION_CODE,
  CGVU_2026_09_25_CHANGE_SUMMARY,
  CGVU_2026_09_25_BODY_HTML,
} from './cgvu-2026-09-25.content';

export async function seedCgvuDraft20260925(): Promise<'created' | 'already_present'> {
  await ensureMigrations();
  if (await getVersionByCode(CGVU_2026_09_25_VERSION_CODE)) return 'already_present';
  await createDraft({
    versionCode: CGVU_2026_09_25_VERSION_CODE,
    title: LEGAL_DOCUMENT_LABEL,
    bodyHtml: CGVU_2026_09_25_BODY_HTML,
    changeSummary: CGVU_2026_09_25_CHANGE_SUMMARY,
    effectiveAt: new Date(`${CGVU_2026_09_25_VERSION_CODE.slice(0, 10)}T00:00:00Z`),
    // Changement d'information (médiateur) : pas de nouvelle acceptation
    // par défaut ; modifiable dans l'administration avant publication.
    requiresReacceptance: false,
  });
  return 'created';
}

if (process.argv[1]?.includes('seed-cgvu-draft')) {
  seedCgvuDraft20260925()
    .then((r) => {
      console.log(r === 'created'
        ? `[cgvu] brouillon ${CGVU_2026_09_25_VERSION_CODE} créé — à publier depuis l'administration`
        : `[cgvu] brouillon ${CGVU_2026_09_25_VERSION_CODE} déjà présent`);
      process.exit(0);
    })
    .catch((e) => { console.error('[cgvu] échec :', (e as Error).message); process.exit(1); });
}
