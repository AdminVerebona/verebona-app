/**
 * Amorçage de la version 1 des CGVU — CDC 7.
 *
 * Idempotent : relancé, il ne crée pas de doublon et ne republie rien. Une
 * version publiée étant figée par la base, une seconde exécution échouerait
 * bruyamment sans cette précaution.
 *
 *   npm run db:seed:cgvu
 */
import { ensureMigrations, getMigrationFailures } from '@/db';
import {
  createDraft,
  publishVersion,
  getVersionByCode,
  getCurrentVersion,
  setCurrentVersion,
  LEGAL_DOCUMENT_LABEL,
} from '@/services/legal';
import {
  CGVU_V1_VERSION_CODE,
  CGVU_V1_CHANGE_SUMMARY,
  CGVU_V1_BODY_HTML,
} from './cgvu-v1.content';

export interface SeedResult {
  status: 'created' | 'already_present';
  versionCode: string;
  permalink: string | null;
  sha256: string | null;
}

export async function seedCgvuV1(): Promise<SeedResult> {
  // ══════════════════════════════════════════════════════════════════════════
  // LES MIGRATIONS D'ABORD
  //
  // Ce script s'exécute hors du serveur Next : `instrumentation.ts`, qui
  // applique les migrations au démarrage, n'a pas été appelé. Sans cette
  // ligne, le seed échoue sur une table inexistante — avec un message
  // Drizzle « Failed query » qui masque la cause réelle.
  //
  // Aucun autre seed du dépôt ne le fait : ils supposent tous que
  // l'application a déjà démarré au moins une fois depuis la dernière
  // migration. Cette hypothèse est fausse sur une base fraîche.
  // ══════════════════════════════════════════════════════════════════════════
  await ensureMigrations();

  const failures = getMigrationFailures();
  if (failures.length > 0) {
    throw new Error(
      `Migrations en échec, schéma incomplet : ${failures.map((f) => f.filename).join(', ')}. ` +
      `Première cause : ${failures[0].message}`,
    );
  }

  const existing = await getVersionByCode(CGVU_V1_VERSION_CODE);
  if (existing) {
    // Déjà publiée. On s'assure seulement qu'une version courante existe :
    // une base amorcée puis migrée pourrait n'en avoir aucune.
    const current = await getCurrentVersion();
    if (!current) await setCurrentVersion(existing.id);
    return {
      status: 'already_present',
      versionCode: existing.versionCode,
      permalink: existing.permalink,
      sha256: existing.sha256,
    };
  }

  const draft = await createDraft({
    versionCode: CGVU_V1_VERSION_CODE,
    title: LEGAL_DOCUMENT_LABEL,
    bodyHtml: CGVU_V1_BODY_HTML,
    changeSummary: CGVU_V1_CHANGE_SUMMARY,
    // Entrée en vigueur à la date portée par le code de version, à minuit UTC.
    effectiveAt: new Date(`${CGVU_V1_VERSION_CODE.slice(0, 10)}T00:00:00Z`),
    // Version initiale : personne n'a rien accepté avant, la notion de
    // nouvelle acceptation requise n'a pas de sens ici (§17).
    requiresReacceptance: false,
  });

  const published = await publishVersion(draft.id, { setAsCurrent: true });

  return {
    status: 'created',
    versionCode: published.versionCode,
    permalink: published.permalink,
    sha256: published.sha256,
  };
}

// Exécution directe : `npx tsx src/db/seeds/legal/seed-cgvu.ts`
if (process.argv[1]?.includes('seed-cgvu')) {
  seedCgvuV1()
    .then((result) => {
      console.log(
        result.status === 'created'
          ? `[cgvu] version ${result.versionCode} publiée et désignée courante`
          : `[cgvu] version ${result.versionCode} déjà présente — rien à faire`,
      );
      console.log(`[cgvu] permalien : ${result.permalink}`);
      console.log(`[cgvu] empreinte : ${result.sha256}`);
      process.exit(0);
    })
    .catch((e) => {
      // Drizzle enveloppe les erreurs PostgreSQL : sans la cause, on lit
      // « Failed query » sans savoir si la table manque, si une contrainte est
      // violée ou si la base est injoignable.
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      console.error('[cgvu] échec :', e.message);
      if (cause?.message) {
        console.error(`[cgvu] cause  : ${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
      }
      if (cause?.code === '42P01') {
        console.error(
          '[cgvu] La table n’existe pas. Vérifiez que la migration ' +
          '0115_legal_document_versions.sql est bien présente dans ' +
          'src/db/migrations/, puis relancez.',
        );
      }
      process.exit(1);
    });
}
