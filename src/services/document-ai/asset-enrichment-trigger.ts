/**
 * Declencheur unique de l'alimentation de la fiche bien a partir des documents.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * `applyAiSuggestionsToAsset()` — le traitement qui remplit l'onglet
 * « Informations » d'un bien a partir du texte de ses documents — n'avait
 * que trois declencheurs, et aucun ne couvrait le geste le plus naturel :
 * rattacher a un bien un document deja analyse.
 *
 *   1. Fin de pipeline (`unified-analysis-pipeline`) : exige
 *      `finalState === 'ANALYZED'` ET un bien deja rattache A L'INSTANT de
 *      l'analyse. Un document depose depuis « Documents » ou depuis le « + »
 *      global n'a pas encore de bien : la condition `if (resolvedAssetId)`
 *      est fausse, et rien n'alimente jamais de fiche.
 *
 *   2. `POST /api/documents/[id]/commit` : l'interface ne l'appelle que
 *      s'il reste des propositions a valider (`needsCommit`). Un document
 *      auto-commite — etat ANALYZED, zero proposition — qu'on rattache
 *      ensuite a un bien ne passe pas par la.
 *
 *   3. Passe horaire, phase 3 : reservee aux items marques
 *      `requires_ai_review` dans `impact_queue`. `enqueueAiReview()` n'est
 *      appelee nulle part : la phase est du code mort.
 *
 * Le rattachement lui-meme (`PUT /api/documents/[id]`) ne declenchait rien
 * d'autre qu'une re-analyse complete en tache de fond — soumise au quota
 * d'analyse (`canConsumeAnalysis`, retour silencieux si epuise), non
 * bloquante, et qui n'alimente la fiche que si elle retombe sur ANALYZED.
 *
 * ── DEUX PROPRIETES QUE CE MODULE APPORTE ─────────────────────────────────
 *
 * VISIBILITE. Les appels existants etaient en `.catch(() => {})` : une cle
 * Gemini absente, un quota atteint ou une reponse illisible disparaissaient
 * sans laisser de trace. Toute issue est desormais journalisee.
 *
 * NON-REDONDANCE. Le meme bien peut etre sollicite deux fois de suite —
 * pipeline puis commit, ou deux documents rattaches coup sur coup. Une
 * fenetre de garde evite d'enchainer deux appels modele identiques.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Motif du declenchement — journalise, et repris dans l'evenement d'impact. */
export type EnrichmentReason =
  | 'document_analyzed'
  | 'document_committed'
  | 'document_attached'
  | 'manual';

/**
 * Fenetre de garde. Deux demandes sur le meme bien dans cet intervalle ne
 * produisent qu'un appel : le second n'aurait rien de plus a lire.
 */
const GUARD_WINDOW_MS = 60_000;

/**
 * Derniere execution par bien. En memoire du processus : une instance
 * supplementaire refera l'appel, ce qui est sans consequence — le traitement
 * est idempotent, il n'ecrit que dans les champs vides.
 */
const dernieresExecutions = new Map<string, number>();

function purger(maintenant: number): void {
  for (const [cle, ts] of dernieresExecutions) {
    if (maintenant - ts > GUARD_WINDOW_MS) dernieresExecutions.delete(cle);
  }
}

export interface TriggerAssetEnrichmentInput {
  assetId: number | null | undefined;
  accountId: number;
  /** Document a l'origine du declenchement, pour la tracabilite. */
  assetFileId?: number | null;
  reason: EnrichmentReason;
  /** Ignore la fenetre de garde — reserve a une demande explicite. */
  force?: boolean;
}

/**
 * Alimente la fiche du bien a partir de ses documents, puis propage l'impact.
 *
 * Ne leve jamais : la plupart des appelants sont en « fire and forget ».
 * L'echec est journalise, jamais avale.
 */
export async function triggerAssetEnrichment(
  input: TriggerAssetEnrichmentInput,
): Promise<void> {
  const { assetId, accountId, assetFileId, reason, force } = input;

  if (!assetId || !accountId) return;

  const cle = `${accountId}:${assetId}`;
  const maintenant = Date.now();
  const derniere = dernieresExecutions.get(cle);

  if (!force && derniere !== undefined && maintenant - derniere < GUARD_WINDOW_MS) {
    console.info(
      `[asset-enrichment] bien ${assetId} déjà traité il y a ` +
      `${Math.round((maintenant - derniere) / 1000)} s — ignoré (${reason})`,
    );
    return;
  }

  dernieresExecutions.set(cle, maintenant);
  purger(maintenant);

  try {
    const { applyAiSuggestionsToAsset } = await import('./apply-ai-suggestions');
    await applyAiSuggestionsToAsset({
      assetId,
      accountId,
      assetFileId: assetFileId ?? undefined,
    });

    console.info(`[asset-enrichment] bien ${assetId} alimenté (${reason})`);

    // Propagation aux objets dependants (agenda, coherence). Distincte de
    // l'alimentation : elle peut echouer sans invalider ce qui vient d'etre
    // ecrit sur la fiche.
    try {
      const { emitAssetUpdated } = await import(
        '../coherence/impact-propagation.service'
      );
      await emitAssetUpdated(accountId, assetId, {
        _trigger: reason,
        _documentId: assetFileId ?? null,
      });
    } catch (err) {
      console.error(
        `[asset-enrichment] propagation d'impact échouée (bien ${assetId}) :`,
        err,
      );
    }
  } catch (err) {
    // La garde est levee : l'echec ne doit pas bloquer une nouvelle tentative
    // pendant une minute.
    dernieresExecutions.delete(cle);
    console.error(
      `[asset-enrichment] alimentation échouée (bien ${assetId}, ${reason}) :`,
      err,
    );
  }
}
