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
import { z } from 'zod';
import { AiGateway } from '../../gateway/ai-gateway';
import type { CorpusRunner } from './corpus-runner';
import type { ObservedResult } from './corpus-comparator';

/**
 * Schéma de sortie attendu du moteur pour un document de corpus.
 *
 * Volontairement permissif sur `fields` : le corpus doit pouvoir accueillir de
 * nouveaux champs sans qu'on modifie le harnais. La rigueur est apportée par
 * les attentes de chaque cas, pas par ce schéma.
 */
const CorpusOutputSchema = z.object({
  documentType: z.string().nullable().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  assetRefs: z.array(z.string()).optional(),
});

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
 * Runner réel.
 *
 * @param operationCode opération déclarée au registre. Par défaut celle de
 *   l'analyse de source : c'est elle qu'une bascule met en jeu.
 */
export function createAnalysisRunner(
  operationCode = 'SOURCE_ANALYSIS_EXTRACT',
): CorpusRunner {
  // `execute` est statique : la passerelle n'a pas d'état par appelant.
  const accountId = corpusAccountId();

  return async ({ corpusCase, content }) => {
    const started = Date.now();

    try {
      const response = await AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS',
        operationCode,
        accountId,
        promptVariables: {
          documentText: htmlToPlainText(content),
          // Le corpus déclare les biens candidats : c'est ce qui permet de
          // détecter une fuite. Sans candidats, le moteur ne pourrait
          // rattacher à rien et le contrôle serait vide de sens.
          candidateAssets: corpusCase.expected.assetRefs ?? [],
        },
        outputSchema: CorpusOutputSchema,
        // Clé stable par cas : rejouer la campagne sans changer le prompt ne
        // doit pas facturer deux fois.
        idempotencyKey: `corpus:${corpusCase.caseId}`,
      });

      const observed: ObservedResult = {
        documentType: response.data.documentType ?? undefined,
        fields: response.data.fields ?? {},
        assetRefs: response.data.assetRefs ?? [],
        schemaValid: true,
        usedFallback: response.usedFallback,
        costMicros: response.costMicros,
        durationMs: response.durationMs,
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
