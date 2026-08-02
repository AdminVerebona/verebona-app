/**
 * Point de bascule de l'usage IA n°1 — CDC §10.1, §10.3 et §10.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN SEUL AIGUILLAGE, ET PAS UN TEST DE DRAPEAU PAR APPELANT
 *
 * `runUnifiedAnalysisPipeline()` est appelé depuis HUIT endroits — dépôt de
 * fichier, analyse par lot, reprise après échec, analyse rétroactive, webhook
 * de facturation, contrôle des analyses en attente, déplacement en masse,
 * consultation d'un document. L'audit n'en recensait que trois.
 *
 * Placer un `if (isEnabled(...))` dans chacun de ces huit fichiers, c'est huit
 * occasions d'oublier une branche, et le risque que l'ancien et le nouveau
 * moteur s'exécutent sur le même document — ce que le §10.4 interdit
 * formellement.
 *
 * D'où cette fonction unique, de signature identique à l'ancienne
 * (`fileIds, accountId`) : la bascule d'un appelant se réduit à changer une
 * ligne d'import, et le choix du moteur se lit à un seul endroit.
 *
 * ⚠️ PAS DE MODE OBSERVATION POUR CET USAGE. Le §10.2 ne prévoit le mode shadow
 * que pour la réconciliation. Il n'a pas de sens ici : le pipeline d'analyse
 * écrit l'état des fichiers, ouvre des lots et supprime les sources secondaires.
 * Deux moteurs en parallèle produiraient une double écriture, interdite par le
 * §10.4. `shadow` est donc traité comme `legacy`, avec un avertissement
 * explicite plutôt qu'un comportement deviné.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { SourceType } from './types';
import { getFlagMode } from '../flags/ai-feature-flags';
import type { RunSourceAnalysisOutput } from './pipeline';

export interface AnalyzeFileSourcesOptions {
  /** Déduit du premier fichier si absent — l'ancienne signature ne le portait pas. */
  userId?: number;
  linkedAssetId?: number | null;
  /** false pour une reprise technique : ne consomme pas de crédit d'analyse. */
  billable?: boolean;
  /** Appelant, journalisé. Indispensable pour suivre une bascule progressive. */
  origin?: string;
  /**
   * Type de source à préparer. `'file'` par défaut — aucun des neuf appelants
   * existants n'a à changer.
   *
   * ══════════════════════════════════════════════════════════════════════
   * POURQUOI CE PARAMÈTRE EXISTE
   *
   * Le corpus de mesure appelait `AiGateway` directement. Il ne traversait
   * donc jamais cette fonction — seul endroit où le drapeau aiguille — et
   * les deux campagnes rendaient des résultats identiques à un champ près :
   * elles exécutaient le même code.
   *
   * Le type était écrit en dur plus bas. L'ouvrir permet au corpus de
   * passer par le pipeline COMPLET, drapeau compris, en servant ses
   * fixtures par un adaptateur dédié.
   *
   * Il reste hors du chemin de production : aucun appelant applicatif ne le
   * renseigne, et `'future_source'` n'est enregistré que le temps d'une
   * campagne.
   * ══════════════════════════════════════════════════════════════════════
   */
  sourceType?: SourceType;
}

let shadowWarned = false;
let webLinkFlagWarned = false;

/**
 * Analyse un ou plusieurs fichiers. Seul point d'entrée autorisé depuis le code
 * applicatif : aucun appelant ne doit importer directement l'un des deux
 * moteurs.
 *
 * Ne lève jamais — la plupart des appelants sont en « fire and forget » et une
 * exception y serait perdue, ou pire, remonterait dans une réponse HTTP déjà
 * envoyée.
 */
export async function analyzeFileSources(
  fileIds: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions = {},
): Promise<RunSourceAnalysisOutput | null> {
  if (fileIds.length === 0 || !accountId) return null;

  const mode = getFlagMode('AI_UNIFIED_SOURCE_ANALYSIS');

  if (mode === 'shadow' && !shadowWarned) {
    shadowWarned = true;
    console.warn(
      '[source-analysis] AI_UNIFIED_SOURCE_ANALYSIS=shadow ignoré : ' +
      "l'analyse unifiée n'a pas de mode observation (CDC §10.2 ne le prévoit " +
      'que pour la réconciliation). Exécution sur le moteur historique. ' +
      'Utilisez `enabled` pour basculer.',
    );
  }

  if (mode !== 'enabled') {
    await runLegacy(fileIds, accountId, options);
    return null;
  }

  return runUnified(fileIds, accountId, options);
}

async function runUnified(
  fileIds: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions,
): Promise<RunSourceAnalysisOutput | null> {
  try {
    const userId = options.userId ?? (await resolveUserId(fileIds[0]));
    if (!userId) {
      console.warn(`[source-analysis] Aucun utilisateur résolu pour le fichier ${fileIds[0]} — abandon.`);
      return null;
    }

    const { runSourceAnalysis } = await import('./pipeline');
    const outcome = await runSourceAnalysis({
      sourceType: options.sourceType ?? 'file',
      sourceIds: fileIds,
      accountId,
      userId,
      linkedAssetId: options.linkedAssetId ?? null,
      billable: options.billable,
    });

    if (outcome.skippedReason) {
      console.info(
        `[source-analysis] ${fileIds.length} fichier(s) non analysé(s) ` +
        `(${outcome.skippedReason}) — origine : ${options.origin ?? 'inconnue'}.`,
      );
    }
    return outcome;
  } catch (e) {
    console.error(
      `[source-analysis] Échec du pipeline unifié (origine : ${options.origin ?? 'inconnue'}) :`,
      (e as Error).message,
    );
    return null;
  }
}

async function runLegacy(
  fileIds: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions,
): Promise<void> {
  try {
    // Import dynamique : le moteur historique n'est pas chargé du tout une fois
    // la bascule faite, ce qui rend son extinction (lot 7) vérifiable.
    const { runUnifiedAnalysisPipeline } = await import(
      '@/services/document-ai/unified-analysis-pipeline'
    );
    await runUnifiedAnalysisPipeline(fileIds, accountId);
  } catch (e) {
    console.error(
      `[source-analysis] Échec du moteur historique (origine : ${options.origin ?? 'inconnue'}) :`,
      (e as Error).message,
    );
  }
}

/**
 * Analyse un lien web. Second point d'entrée autorisé.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE LIEN WEB NE SUIT PAS LE DRAPEAU
 *
 * La route `/api/web-links/[id]/analyze` appelait `runSourceAnalysis`
 * DIRECTEMENT, court-circuitant cet aiguillage. Conséquence, avec le drapeau
 * à `legacy` : un fichier partait sur le moteur historique et un lien web sur
 * le nouveau. Deux schémas de sortie différents pour le même compte, ce que le
 * §4.1.7 interdit — « un lien web produit les mêmes informations qu'un
 * document ».
 *
 * Ce comportement est en réalité INÉVITABLE, et c'est pourquoi il est nommé
 * ici plutôt que corrigé : le lien web n'a plus de moteur historique. Sa
 * logique Gemini propre — 338 lignes inlinées dans la route — a été supprimée
 * au lot 1 (§4.1.5), puisqu'elle ne servait qu'à lui. Il n'existe donc aucune
 * branche `legacy` vers laquelle basculer.
 *
 * Trois options se présentaient :
 *   • laisser l'appel direct → l'écart reste, mais invisible ;
 *   • refuser l'analyse quand le drapeau vaut `legacy` → casse une
 *     fonctionnalité qui marche, pour une pureté sans bénéfice ;
 *   • passer par l'aiguillage et NOMMER l'exception → retenu.
 *
 * L'invariant « aucun appelant applicatif n'importe le moteur » est ainsi
 * rétabli, et l'écart devient un message de journal explicite plutôt qu'une
 * surprise le jour de la bascule. Le contrôle CI (critère 24) empêche
 * désormais tout nouvel appel direct.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function analyzeWebLinkSource(
  webLinkId: number,
  accountId: number,
  options: { userId: number },
): Promise<RunSourceAnalysisOutput> {
  const mode = getFlagMode('AI_UNIFIED_SOURCE_ANALYSIS');

  if (mode !== 'enabled' && !webLinkFlagWarned) {
    webLinkFlagWarned = true;
    console.info(
      `[source-analysis] AI_UNIFIED_SOURCE_ANALYSIS=${mode} : les liens web ` +
      "sont analysés par le moteur unifié malgré tout — ils n'ont pas de " +
      'moteur historique (CDC §4.1.5). Les fichiers, eux, suivent le drapeau. ' +
      'Cet écart disparaît dès la bascule à `enabled`.',
    );
  }

  const { runSourceAnalysis } = await import('./pipeline');
  return runSourceAnalysis({
    sourceType: 'web_link',
    sourceIds: [webLinkId],
    accountId,
    userId: options.userId,
  });
}

async function resolveUserId(fileId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: assetFiles.userId })
    .from(assetFiles)
    .where(eq(assetFiles.id, fileId))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Abonne un flux SSE à la progression d'analyse d'un fichier, quel que soit le
 * moteur actif.
 *
 * ⚠️ CORRECTION D'UN DÉFAUT QUI SERAIT APPARU À LA BASCULE. Il existe DEUX
 * registres d'abonnés SSE indépendants : celui de `unified-analysis-pipeline`
 * et celui de `source-analysis/stream/broadcast`. La route
 * `documents/[id]/stream` ne connaissait que le premier. Le jour où le drapeau
 * passe à `enabled`, elle n'aurait plus rien reçu : l'interface serait restée
 * bloquée sur « analyse en cours » jusqu'au délai de cinq minutes, sans erreur
 * ni trace.
 *
 * L'abonnement est fait aux deux registres, sans test de drapeau. Un abonné
 * inscrit dans un registre qui n'émet jamais ne coûte rien, et cette
 * indépendance au drapeau garantit que le flux fonctionne aussi pendant une
 * bascule à chaud, quand une analyse déjà lancée sur un moteur est observée
 * après changement de configuration.
 */
export async function registerAnalysisStreamWriter(
  assetFileId: number,
  writer: (data: Record<string, unknown>) => void,
): Promise<() => void> {
  const [unified, legacy] = await Promise.all([
    import('./stream/broadcast'),
    import('@/services/document-ai/unified-analysis-pipeline'),
  ]);

  const off = [
    unified.registerStreamWriter(assetFileId, writer),
    legacy.registerStreamWriter(assetFileId, writer),
  ];

  return () => { for (const fn of off) fn(); };
}

/** Le pipeline unifié est-il le moteur actif ? Lecture seule, sans effet de bord. */
export function isUnifiedAnalysisActive(): boolean {
  return getFlagMode('AI_UNIFIED_SOURCE_ANALYSIS') === 'enabled';
}

/** Réservé aux tests : réarme l'avertissement de mode observation. */
export function resetEntrypointWarnings(): void {
  shadowWarned = false;
}
