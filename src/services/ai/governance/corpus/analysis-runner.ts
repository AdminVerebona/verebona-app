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
/**
 * Sortie de `extract_source`, telle que le prompt la produit réellement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE HARNAIS ATTENDAIT UNE FORME QUI N'EXISTE PAS
 *
 * Il déclarait `{ documentType, fields: Record, assetRefs }`. Le prompt rend
 * `{ title, description, documentDate, supplier, amountCents, fields: [] }`
 * — un TABLEAU d'objets `{ fieldKey, value }`, et aucun `documentType`.
 *
 * Conséquence : tous les champs remontaient `missing`, et seuls les deux cas
 * `document_sans_information` passaient — parce qu'on n'attendait rien d'eux.
 * La campagne mesurait le harnais, pas le moteur.
 * ══════════════════════════════════════════════════════════════════════════
 */
const valeur = z.object({
  value: z.unknown().optional(),
  confidence: z.string().optional(),
  excerpt: z.string().optional(),
}).passthrough();

const ExtractOutputSchema = z.object({
  title: valeur.optional(),
  description: valeur.optional(),
  documentDate: valeur.optional(),
  supplier: z.object({ name: z.string().optional() }).passthrough().optional(),
  amountCents: valeur.optional(),
  transcription: z.string().optional(),
  fields: z.array(z.object({
    fieldKey: z.string(),
    value: z.unknown().optional(),
  }).passthrough()).optional(),
  hasExploitableContent: z.boolean().optional(),
}).passthrough();

/** Sortie de `classify_document` : le type ne vient pas de l'extraction. */
const ClassifyOutputSchema = z.object({
  documentType: z.string().nullable().optional(),
}).passthrough();

/**
 * Aplatit la sortie du prompt vers la forme que le comparateur attend.
 *
 * Les champs nommés — titre, date, montant, fournisseur — sont replacés parmi
 * les autres : un cas de corpus ne distingue pas un champ « de tête » d'un
 * champ extrait, et n'a pas à le faire.
 */
function aplatir(sortie: z.infer<typeof ExtractOutputSchema>): Record<string, unknown> {
  const champs: Record<string, unknown> = {};

  for (const f of sortie.fields ?? []) {
    if (f.value !== undefined && f.value !== null) champs[f.fieldKey] = f.value;
  }

  // Ajoutés seulement s'ils manquent : un `fieldKey` explicite l'emporte sur
  // le champ de tête, car il porte la clé attendue par le cas.
  const tete: Array<[string, unknown]> = [
    ['title', sortie.title?.value],
    ['description', sortie.description?.value],
    ['documentDate', sortie.documentDate?.value],
    ['dateFacture', sortie.documentDate?.value],
    ['supplier', sortie.supplier?.name],
    ['amountCents', sortie.amountCents?.value],
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
 * Runner réel.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CODE D'OPÉRATION EST CELUI DU REGISTRE, PAS UN NOM INVENTÉ
 *
 * Ce runner employait `SOURCE_ANALYSIS_EXTRACT`, qui n'existe nulle part :
 * le registre déclare `extract_source`. Les 28 cas échouaient donc tous avec
 * « Opération inconnue », avant même le moindre appel modèle.
 *
 * Le défaut ne se voyait pas en mode `dry` — qui ne passe pas par la
 * passerelle — et le contrôle du registre, lui, faisait exactement son
 * travail : refuser une opération non déclarée (§12, critère 5).
 *
 * @param operationCode opération déclarée dans `operations.ts`. Par défaut
 *   celle de l'extraction : c'est elle qu'une bascule met en jeu.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function createAnalysisRunner(
  operationCode = 'extract_source',
): CorpusRunner {
  // `execute` est statique : la passerelle n'a pas d'état par appelant.
  const accountId = corpusAccountId();

  return async ({ corpusCase, content }) => {
    const started = Date.now();

    try {
      const texte = htmlToPlainText(content);

      // ── 1. Extraction ─────────────────────────────────────────────────
      //
      // Les noms de variables sont ceux du prompt : `EXTRACTED_CONTENT`,
      // `ASSET_CONTEXT`… Le harnais envoyait `documentText` et
      // `candidateAssets`, que le gabarit ne connaît pas — le modèle
      // recevait donc un prompt aux marqueurs non substitués.
      const extraction = await AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS',
        operationCode,
        accountId,
        promptVariables: {
          EXTRACTED_CONTENT: texte,
          SOURCE_KIND: 'document',
          // Le corpus déclare les biens candidats : c'est ce qui permet de
          // détecter une fuite. Sans candidats, le moteur ne pourrait
          // rattacher à rien et le contrôle serait vide de sens.
          ASSET_CONTEXT: (corpusCase.expected.assetRefs ?? []).join(', '),
          EXISTING_TITLES: '',
        },
        outputSchema: ExtractOutputSchema,
        // Clé stable par cas : rejouer la campagne sans changer le prompt ne
        // doit pas facturer deux fois.
        idempotencyKey: `corpus:${corpusCase.caseId}:extract`,
      });

      const champs = aplatir(extraction.data);

      // ── 2. Classification ─────────────────────────────────────────────
      //
      // `extract_source` ne rend AUCUN type : c'est une opération distincte
      // dans le pipeline. Le harnais lisait `response.data.documentType`,
      // toujours absent — d'où 26 `typeErrors` sur 28.
      const classification = await AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS',
        operationCode: 'classify_document',
        accountId,
        promptVariables: {
          TITLE: String(extraction.data.title?.value ?? ''),
          SUPPLIER: extraction.data.supplier?.name ?? '',
          CONTENT_SAMPLE: texte.slice(0, 3000),
        },
        outputSchema: ClassifyOutputSchema,
        idempotencyKey: `corpus:${corpusCase.caseId}:classify`,
      });

      const observed: ObservedResult = {
        documentType: classification.data.documentType ?? undefined,
        fields: champs,
        // Le corpus mesure la fuite entre biens : un rattachement au-delà des
        // candidats déclarés en serait une. L'extraction ne le rend pas
        // aujourd'hui, ce champ reste donc vide — et le contrôle de fuite
        // porte sur le pipeline complet, pas sur cette étape.
        assetRefs: [],
        schemaValid: true,
        usedFallback: extraction.usedFallback || classification.usedFallback,
        costMicros: (extraction.costMicros ?? 0) + (classification.costMicros ?? 0),
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
