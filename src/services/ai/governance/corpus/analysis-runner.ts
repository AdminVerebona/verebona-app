/**
 * Runner branché sur le moteur d'analyse — CDC §11.1 et §5.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TOUT PASSE PAR LA PASSERELLE, Y COMPRIS LA MESURE
 *
 * Le §5.2 interdit tout accès direct au SDK fournisseur hors de `AiGateway`.
 * Un harnais de mesure qui s'en affranchirait mesurerait autre chose que ce
 * qui tourne en production — coût non compté, invite hors gouvernance,
 * repli fournisseur invisible.
 *
 * Ce runner passe donc par la passerelle comme n'importe quel appelant. Les
 * coûts de la campagne apparaissent dans les mêmes tableaux que ceux de
 * l'exploitation, ce qui permet de chiffrer une bascule avant de la décider.
 *
 * ── LE COMPTE DE MESURE ───────────────────────────────────────────────────
 *
 * Les appels sont rattachés à un compte technique, désigné par
 * `CORPUS_ACCOUNT_ID`. Sans lui, la campagne polluerait les coûts d'un compte
 * client réel — et fausserait précisément la mesure qu'elle sert à produire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { T1_MASTER_PROMPT_CODE, type T1AnalyzeDocumentOutput } from '../../source-analysis/master/t1-contract';
import { T1AnalyzeDocumentTolerantOutput, splitNormalisation } from '../../source-analysis/master/tolerant-output';
import { buildAnalyzeDocumentVariables } from '../../source-analysis/master/prompt-context';
import type { CorpusRunner } from './corpus-runner';
import type { ObservedResult } from './corpus-comparator';

/** Opération mesurée : branche ANALYZE_DOCUMENT du prompt maître T1. */
export const CORPUS_T1_OPERATION = 't1_analyze_document';

/**
 * Aplatit la sortie ANALYZE_DOCUMENT vers la forme que le comparateur attend.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 16b-3 : LE HARNAIS MESURE LE MASTER T1
 *
 * Il appelait `extract_source` puis `classify_document`, opérations d'étapes
 * supprimées avec l'ancien moteur. Il appelle désormais la branche
 * ANALYZE_DOCUMENT du master (`t1_analyze_document`), UN appel qui rend à la
 * fois la classification et les faits.
 *
 * Les faits sont rangés sous leur clé canonique (`canonicalKey`), à défaut
 * leur clé lue (`rawKey`) ; les métadonnées de tête — titre, date, montant,
 * fournisseur — sont ajoutées seulement si un fait ne porte pas déjà la clé
 * attendue par le cas, qui fait autorité.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function aplatir(sortie: T1AnalyzeDocumentOutput): Record<string, unknown> {
  const champs: Record<string, unknown> = {};

  for (const f of sortie.facts ?? []) {
    const cle = f.canonicalKey ?? f.rawKey ?? null;
    if (cle && f.normalizedValue !== undefined && f.normalizedValue !== null) champs[cle] = f.normalizedValue;
  }

  const doc = sortie.document ?? {};
  const tete: Array<[string, unknown]> = [
    ['title', doc.title?.value],
    ['description', doc.description?.value],
    ['documentDate', doc.documentDate?.value],
    ['dateFacture', doc.documentDate?.value],
    ['supplier', doc.supplier?.name],
    ['amountCents', doc.amountCents?.value],
  ];
  for (const [cle, v] of tete) {
    if (v !== undefined && v !== null && champs[cle] === undefined) champs[cle] = v;
  }

  return champs;
}

/** Compte technique portant les appels de mesure. */
function corpusAccountId(): number {
  const raw = Number(process.env.CORPUS_ACCOUNT_ID);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      'CORPUS_ACCOUNT_ID est absente ou invalide. Renseignez un compte technique : ' +
      'rattacher la campagne à un compte client fausserait ses coûts.',
    );
  }
  return raw;
}

/**
 * Convertit le texte d'un document HTML en texte brut.
 *
 * Les documents du corpus sont en HTML pour rester lisibles et diffables. Le
 * moteur, lui, reçoit ce que produirait une extraction : du texte, sans
 * balises. Lui transmettre le HTML l'avantagerait artificiellement — la
 * structure d'un tableau y est explicite, ce qu'un PDF numérisé n'offre pas.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(tr|p|h1|h2|div|li)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Runner réel : branche ANALYZE_DOCUMENT du prompt maître T1, par la
 * passerelle (coût, trace, configuration de la version effective).
 *
 * Le code d'opération est celui du registre (`t1_analyze_document`), jamais
 * un nom inventé : un code inconnu échouait avant le moindre appel modèle, et
 * le mode `dry` — qui ne passe pas par la passerelle — ne le voyait pas.
 *
 * Variables : exactement celles du master (`buildAnalyzeDocumentVariables`),
 * construites sur une source texte synthétique et un contexte d'entités formé
 * des biens candidats déclarés par le cas (identifiants fictifs : la mesure
 * de fuite porte sur les libellés, aucun identifiant n'est revérifié ici).
 */
export function createAnalysisRunner(
  operationCode = CORPUS_T1_OPERATION,
): CorpusRunner {
  // ══════════════════════════════════════════════════════════════════════
  // UNE CLÉ PAR CAMPAGNE, PAS PAR CAS
  //
  // Une clé stable d'une campagne à l'autre faisait rejouer à la seconde
  // campagne les réponses de la première (2 ms par cas, coût nul) : elle ne
  // mesurait rien. L'identifiant de campagne rend chaque exécution distincte ;
  // l'idempotence garde son rôle à l'intérieur d'une campagne.
  // ══════════════════════════════════════════════════════════════════════
  const campagne = `${Date.now().toString(36)}`;
  // `execute` est statique : la passerelle n'a pas d'état par appelant.
  const accountId = corpusAccountId();

  return async ({ corpusCase, content }) => {
    const started = Date.now();

    try {
      const texte = htmlToPlainText(content);
      const candidats = corpusCase.expected.assetRefs ?? [];

      const variables = buildAnalyzeDocumentVariables({
        input: {
          sourceType: 'file',
          sourceIds: [0],
          accountId,
          userId: 0,
          mimeTypes: ['text/plain'],
          displayNames: [`${corpusCase.caseId}.txt`],
          // Le moteur reçoit ce que produirait une extraction : du texte.
          extractedContent: texte,
        },
        groupIndices: [0],
        ctx: {
          accountId,
          userId: 0,
          // Le corpus déclare les biens candidats : c'est ce qui permet de
          // détecter une fuite (rattachement hors des candidats).
          assets: candidats.map((label, i) => ({ id: i + 1, name: label, category: null, subtype: null })),
          rooms: [],
          equipments: [],
          existingTitles: [],
          linkedAssetId: null,
        },
        v2Families: [],
      });

      const analyse = await AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS',
        operationCode,
        task: 'ANALYZE_DOCUMENT',
        masterPromptCode: T1_MASTER_PROMPT_CODE,
        accountId,
        promptVariables: variables,
        // Même normalisation tolérante que la production (`analyze-document.step`).
        outputSchema: T1AnalyzeDocumentTolerantOutput,
        idempotencyKey: `corpus:${campagne}:${corpusCase.caseId}:analyze`,
        // Lot 22 : campagne de mesure du BO, hors plafond de coût du compte.
        costCapExempt: true,
      });
      const { output } = splitNormalisation(analyse.data);

      const c = output.document.classification;
      const observed: ObservedResult = {
        documentType: c?.canonicalType ?? c?.documentTypeCode ?? undefined,
        fields: aplatir(output),
        // Rattachements proposés, ramenés aux libellés des candidats du cas.
        assetRefs: output.entities.assets
          .map((a) => (a.entityId ? candidats[a.entityId - 1] : a.rawLabel) ?? null)
          .filter((x): x is string => Boolean(x)),
        schemaValid: true,
        usedFallback: analyse.usedFallback,
        costMicros: analyse.costMicros ?? 0,
        durationMs: Date.now() - started,
      };
      return observed;
    } catch (e) {
      // Une sortie hors schéma n'est pas une erreur d'exécution : c'est un
      // résultat, et il doit être compté comme tel. Les distinguer permet de
      // voir si un moteur échoue à produire du JSON valide plutôt que de
      // croire à une panne d'infrastructure.
      const message = (e as Error).message ?? '';
      if (/schema|zod|validation/i.test(message)) {
        return {
          schemaValid: false,
          fields: {},
          assetRefs: [],
          durationMs: Date.now() - started,
        };
      }
      throw e;
    }
  };
}

/**
 * Runner de démonstration, sans appel modèle.
 *
 * Il rend exactement le résultat attendu : la campagne passe donc à 100 %.
 * Son utilité n'est pas de mesurer un moteur, mais de vérifier la CHAÎNE —
 * lecture des fixtures, comparaison, rapport, verdict — avant de dépenser le
 * moindre appel. Un harnais qu'on découvre cassé au milieu d'une campagne
 * payante est un harnais inutile.
 */
export function createDryRunner(): CorpusRunner {
  return async ({ corpusCase }) => ({
    documentType: corpusCase.expected.documentType,
    fields: corpusCase.expected.fields ?? {},
    assetRefs: corpusCase.expected.assetRefs ?? [],
    schemaValid: true,
    usedFallback: false,
    costMicros: 0,
    durationMs: 0,
  });
}
