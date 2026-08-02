/**
 * Runner de pipeline — mesure ce que la bascule change vraiment.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE RUNNER PRÉCÉDENT NE TRAVERSAIT PAS LA BASCULE
 *
 * `analysis-runner.ts` appelle `AiGateway.execute` directement. Il court-
 * circuite `analyzeFileSources`, seul endroit où `AI_UNIFIED_SOURCE_ANALYSIS`
 * aiguille — et les deux campagnes ont rendu 4 conformes, 15 erreurs de type
 * des deux côtés. Elles exécutaient le même code.
 *
 * Ce runner-ci passe par `analyzeFileSources`. Tout le pipeline s'exécute :
 * regroupement, extraction, classification, entités, catégorie, persistance,
 * événements aval — et l'aiguillage décide lequel des deux moteurs travaille.
 *
 * ── IL LUI FAUT DE VRAIES LIGNES ──────────────────────────────────────────
 *
 * `analyzeFileSources` prend des `asset_files.id`. Une ligne est donc créée
 * par cas, sur le compte technique, puis supprimée. Le contenu vient d'un
 * adaptateur dédié : téléverser 28 fixtures à chaque campagne coûterait du
 * temps, laisserait des objets à purger, et ferait dépendre la mesure d'un
 * service tiers.
 *
 * Ce qui n'est PAS mesuré en contrepartie : lecture du stockage, extraction
 * bureautique, rendu PDF. Ces étapes précèdent le point de bascule et sont
 * communes aux deux moteurs — les écarter ne fausse pas la comparaison.
 *
 * ── LES LIGNES SONT SUPPRIMÉES, TOUJOURS ──────────────────────────────────
 *
 * Y compris en cas d'échec. Sans cela, chaque campagne laisserait 28
 * documents sur le compte technique, et la suivante analyserait un parc qui
 * grossit — ce que le regroupement de sources prendrait pour des doublons.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db, pgClient } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { analyzeFileSources } from '../../source-analysis/entrypoint';
import {
  CorpusSourceAdapter,
  declarerFixture,
  viderFixtures,
} from '../../source-analysis/adapters/corpus-source.adapter';
import { registerSourceAdapter } from '../../source-analysis/adapters';
import type { CorpusRunner } from './corpus-runner';
import type { ObservedResult } from './corpus-comparator';

/** Enregistré une seule fois : deux inscriptions écraseraient la première. */
let adaptateurEnregistre = false;

function enregistrerAdaptateur(): void {
  if (adaptateurEnregistre) return;
  registerSourceAdapter(new CorpusSourceAdapter());
  adaptateurEnregistre = true;
}

function compteCorpus(): number {
  const brut = Number(process.env.CORPUS_ACCOUNT_ID);
  if (!Number.isInteger(brut) || brut <= 0) {
    throw new Error(
      '[corpus-pipeline] CORPUS_ACCOUNT_ID absente. Rattacher la campagne à un ' +
      'compte client mélangerait ses coûts réels avec ceux de la mesure.',
    );
  }
  return brut;
}

/**
 * Crée la ligne `asset_files` d'un cas.
 *
 * L'utilisateur propriétaire du compte technique est retrouvé plutôt que
 * supposé : `user_id` est obligatoire, et une valeur inventée casserait la
 * clé étrangère au premier cas.
 */
async function creerSource(caseId: string, accountId: number): Promise<number> {
  const [proprietaire] = await pgClient<{ owner_user_id: number }[]>`
    SELECT owner_user_id FROM accounts WHERE id = ${accountId}
  `;
  if (!proprietaire) {
    throw new Error(`[corpus-pipeline] Compte ${accountId} introuvable.`);
  }

  const [ligne] = await db
    .insert(assetFiles)
    .values({
      accountId,
      userId: proprietaire.owner_user_id,
      filename: `${caseId}.txt`,
      originalFilename: `${caseId}.txt`,
      mimeType: 'text/plain',
      // Clé factice : l'adaptateur de corpus sert le contenu, rien n'est lu
      // dans le stockage. Le préfixe la rend reconnaissable si une ligne
      // survivait à une purge.
      s3Key: `corpus/${caseId}`,
      analysisState: 'PENDING',
    })
    .returning({ id: assetFiles.id });

  return ligne.id;
}

/** Supprime la ligne, quoi qu'il arrive. */
async function supprimerSource(id: number): Promise<void> {
  await db.delete(assetFiles).where(eq(assetFiles.id, id)).catch((e) => {
    console.error(`[corpus-pipeline] source ${id} non supprimée :`, (e as Error).message);
  });
}

/**
 * Runner traversant le pipeline complet.
 *
 * Le résultat est relu en base plutôt que pris dans la valeur de retour :
 * `analyzeFileSources` rend `null` sur le moteur historique, par conception.
 * Lire ce que le pipeline a ÉCRIT est d'ailleurs plus fidèle — c'est ce que
 * l'utilisateur verra.
 */
export function createPipelineRunner(): CorpusRunner {
  enregistrerAdaptateur();
  const accountId = compteCorpus();

  return async ({ corpusCase, content }) => {
    const debut = Date.now();
    let sourceId: number | null = null;

    try {
      sourceId = await creerSource(corpusCase.caseId, accountId);
      declarerFixture(sourceId, content, `${corpusCase.caseId}.txt`);

      await analyzeFileSources([sourceId], accountId, {
        // Le corpus emprunte l'adaptateur dédié, non le stockage.
        sourceType: 'future_source',
        // Une campagne ne doit pas consommer les crédits du compte technique :
        // elle mesure, elle ne rend pas de service.
        billable: false,
        origin: 'corpus-pipeline',
      });

      // ── Relecture de ce qui a été écrit ────────────────────────────────
      const [ecrit] = await pgClient<{
        document_type: string | null;
        analysis_state: string | null;
        asset_id: number | null;
      }[]>`
        SELECT document_type, analysis_state, asset_id
        FROM asset_files WHERE id = ${sourceId}
      `;

      const champs = await pgClient<{ field_key: string; value_text: string | null }[]>`
        SELECT field_key, value_text
        FROM ai_field_updates
        WHERE asset_file_id = ${sourceId}
      `;

      const observed: ObservedResult = {
        documentType: ecrit?.document_type ?? undefined,
        fields: Object.fromEntries(champs.map((c) => [c.field_key, c.value_text])),
        // Un rattachement hors des biens candidats serait une fuite. Le compte
        // technique n'ayant aucun bien, tout rattachement en serait une.
        assetRefs: ecrit?.asset_id ? [String(ecrit.asset_id)] : [],
        schemaValid: ecrit?.analysis_state !== 'ANALYSIS_FAILED',
        durationMs: Date.now() - debut,
      };
      return observed;
    } finally {
      // Supprimée même en cas d'échec : une campagne suivante analyserait
      // sinon un parc qui grossit, et le regroupement y verrait des doublons.
      if (sourceId !== null) await supprimerSource(sourceId);
      viderFixtures();
    }
  };
}
