/**
 * Lot 111M (ticket « budgets IA », §5 BO) — LIMITES APPLICATIVES EFFECTIVES,
 * par traitement et opération, avec leur ORIGINE (surcharge explicite ou
 * valeur par défaut du code) et leur rôle.
 *
 * Lecture seule, pure (environnement et réglages BO de l'assistant fournis) :
 * aucune nouvelle source de vérité — chaque valeur est lue par la MÊME
 * fonction que le traitement (`knowledgeBounds`, `chunkSettings`,
 * `t4EvidenceBounds`, `namingBudget`, configuration de l'assistant). Les
 * plafonds MODÈLE (sortie transmise, limite du modèle, entrée disponible)
 * sont affichés par les profils effectifs (`/api/admin/ai/model-capabilities`).
 * Aucun nouveau réglage n'est créé : ce qui est résolu automatiquement
 * (capacités du modèle, prompt actif) n'est pas administrable.
 */
import { knowledgeBounds, continuationPageCap, DEFAULT_KNOWLEDGE_BOUNDS } from '../reconciliation/knowledge-query/context';
import { chunkSettings } from '../source-analysis/source-units/page-chunks';
import { t4EvidenceBounds } from '../agenda/master/verify-completion';
import { t4ClassifyEvidenceChars } from '../agenda/master/classify-event';
import { namingBudget } from '../reconciliation/document-naming/adaptive';
import { ASSISTANT_EXCERPT_READ_CHARS, ASSISTANT_INPUT_SAFETY_TOKENS } from '@/services/verebona-assistant/config/assistant-limits';

export interface ApplicationLimit {
  treatment: 'T1' | 'T2' | 'T3' | 'T4' | 'T6';
  operation: string;
  name: string;
  value: number | string;
  unit: 'jetons' | 'caractères' | 'pages' | 'éléments' | 'appels' | 'ratio' | 'documents' | 'faits' | 'candidats';
  origin: 'explicit_override' | 'default' | 'resolved' | 'fixed';
  /** Variable de surcharge (nom seulement), si la limite est réglable. */
  variable: string | null;
  role: string;
}

type Env = Record<string, string | undefined>;
const pose = (env: Env, k: string) => (env[k] ?? '').trim() !== '';

/** Limites applicatives effectives (pure). `assistant` : configuration effective de l'assistant (BO > env > défaut). */
export function effectiveApplicationLimits(env: Env = process.env, assistant?: {
  maxInputTokens: number; maxInputTokensExplicit: boolean; maxExcerptChars: number; maxSources: number; maxVisibleSources: number;
}): ApplicationLimit[] {
  const out: ApplicationLimit[] = [];
  const o = (k: string): ApplicationLimit['origin'] => (pose(env, k) ? 'explicit_override' : 'default');
  // T1
  const c = chunkSettings(env);
  out.push(
    { treatment: 'T1', operation: 't1_analyze_document', name: 'Pages par lot de continuation', value: c.chunkPages, unit: 'pages', origin: o('T1_CHUNK_PAGES'), variable: 'T1_CHUNK_PAGES', role: 'découpage d’un document saturé' },
    { treatment: 'T1', operation: 't1_analyze_document', name: 'Lots de pages au plus', value: c.maxChunks, unit: 'appels', origin: o('T1_MAX_CHUNKS'), variable: 'T1_MAX_CHUNKS', role: 'borne de coût ; au-delà : lacune signalée' },
    c.saturationExplicit
      ? { treatment: 'T1', operation: 't1_analyze_document', name: 'Seuil de saturation (absolu)', value: c.saturationOutputTokens, unit: 'jetons', origin: 'explicit_override', variable: 'T1_SATURATION_OUTPUT_TOKENS', role: 'surcharge explicite du seuil' }
      : { treatment: 'T1', operation: 't1_analyze_document', name: 'Seuil de saturation (part du plafond transmis)', value: c.saturationRatio, unit: 'ratio', origin: o('T1_SATURATION_RATIO'), variable: 'T1_SATURATION_RATIO', role: 'saturation = MAX_TOKENS fournisseur ou jetons produits ≥ ratio × plafond transmis' },
  );
  // T2
  const a = assistant ?? { maxInputTokens: ASSISTANT_INPUT_SAFETY_TOKENS, maxInputTokensExplicit: false, maxExcerptChars: ASSISTANT_EXCERPT_READ_CHARS, maxSources: 8, maxVisibleSources: 5 };
  out.push(
    { treatment: 'T2', operation: 't2_answer', name: 'Plafond de sécurité d’entrée (contexte réel)', value: a.maxInputTokens, unit: 'jetons', origin: a.maxInputTokensExplicit ? 'explicit_override' : 'default', variable: 'VEREBONA_ASSISTANT_MAX_INPUT_TOKENS', role: 'latence 12 s et coût ; borné par l’entrée du modèle' },
    { treatment: 'T2', operation: 't2_answer', name: 'Lecture d’un extrait', value: a.maxExcerptChars, unit: 'caractères', origin: a.maxExcerptChars === ASSISTANT_EXCERPT_READ_CHARS ? 'default' : 'explicit_override', variable: 'VEREBONA_ASSISTANT_MAX_EXCERPT_CHARS', role: 'borne de lecture ; raccourci seulement si le budget d’entrée est dépassé' },
    { treatment: 'T2', operation: 't2_answer', name: 'Sources transmises', value: a.maxSources, unit: 'éléments', origin: a.maxSources === 8 ? 'default' : 'explicit_override', variable: 'VEREBONA_ASSISTANT_MAX_SOURCES', role: 'CDC Assistant §13.9 (≤ 8) ; toute exclusion tracée' },
    { treatment: 'T2', operation: 't2_answer', name: 'Réserve du prompt', value: 'prompt maître actif mesuré', unit: 'jetons', origin: 'resolved', variable: null, role: 'remplace la réserve forfaitaire de 3 000 (repli seulement)' },
    { treatment: 'T2', operation: 't2_answer', name: 'Longueur de réponse', value: 'repère 4 phrases / 1 200 car. (synthèse 3 000)', unit: 'caractères', origin: 'fixed', variable: null, role: 'repère tracé, jamais une coupe' },
  );
  // T3
  const k = knowledgeBounds(env);
  out.push(
    { treatment: 'T3', operation: 't3_knowledge_query', name: 'Caractères par segment d’élément', value: k.charsPerElement, unit: 'caractères', origin: o('T3_KNOWLEDGE_QUERY_CHARS_PER_ELEMENT'), variable: 'T3_KNOWLEDGE_QUERY_CHARS_PER_ELEMENT', role: 'texte long découpé en segments (aucune perte)' },
    { treatment: 'T3', operation: 't3_knowledge_query', name: 'Pages par passage', value: k.maxPages, unit: 'pages', origin: o('T3_KNOWLEDGE_QUERY_MAX_PAGES'), variable: 'T3_KNOWLEDGE_QUERY_MAX_PAGES', role: 'appels par passage' },
    { treatment: 'T3', operation: 't3_knowledge_query', name: 'Pages au total (continuation)', value: continuationPageCap(k), unit: 'pages', origin: o('T3_KNOWLEDGE_QUERY_MAX_CONTINUATION_PAGES'), variable: 'T3_KNOWLEDGE_QUERY_MAX_CONTINUATION_PAGES', role: `au-delà : INCOMPLET explicite (défaut ${DEFAULT_KNOWLEDGE_BOUNDS.maxContinuationPages})` },
    { treatment: 'T3', operation: 't3_knowledge_query', name: 'Caractères par page', value: k.charsPerPage, unit: 'caractères', origin: o('T3_KNOWLEDGE_QUERY_CHARS_PER_PAGE'), variable: 'T3_KNOWLEDGE_QUERY_CHARS_PER_PAGE', role: 'taille d’un appel' },
  );
  const n = namingBudget(env);
  const no = (x: keyof NonNullable<typeof n.origins>) => (n.origins?.[x] ?? 'default') as ApplicationLimit['origin'];
  out.push(
    { treatment: 'T3', operation: 't3_document_naming', name: 'Entrée visée par appel', value: n.inputTokens, unit: 'jetons', origin: no('inputTokens'), variable: 'T3_NAMING_INPUT_TOKEN_BUDGET', role: 'redécoupage avant envoi' },
    { treatment: 'T3', operation: 't3_document_naming', name: 'Sortie visible visée par appel', value: n.outputTokens, unit: 'jetons', origin: no('outputTokens'), variable: 'T3_NAMING_OUTPUT_TOKEN_BUDGET', role: 'bornée par le plafond transmis (raisonnement compris)' },
    { treatment: 'T3', operation: 't3_document_naming', name: 'Partie fixe du prompt', value: n.promptOverheadTokens, unit: 'jetons', origin: no('promptOverheadTokens'), variable: 'T3_NAMING_PROMPT_OVERHEAD_TOKENS', role: 'prompt maître actif mesuré + contrat' },
  );
  // T4
  const t4 = t4EvidenceBounds(env);
  out.push(
    { treatment: 'T4', operation: 't4_verify_completion', name: 'Preuve par appel (fenêtre)', value: t4.charsPerCall, unit: 'caractères', origin: o('T4_EVIDENCE_CHARS_PER_CALL'), variable: 'T4_EVIDENCE_CHARS_PER_CALL', role: 'lecture par fenêtres successives' },
    { treatment: 'T4', operation: 't4_verify_completion', name: 'Relectures ciblées au plus', value: t4.maxRereads, unit: 'appels', origin: o('T4_EVIDENCE_MAX_REREADS'), variable: 'T4_EVIDENCE_MAX_REREADS', role: 'au-delà : aucune décision définitive' },
    { treatment: 'T4', operation: 't4_classify_event', name: 'Indice documentaire', value: t4ClassifyEvidenceChars(env), unit: 'caractères', origin: o('T4_CLASSIFY_EVIDENCE_CHARS'), variable: 'T4_CLASSIFY_EVIDENCE_CHARS', role: 'classification d’après titre, date, nature' },
  );
  // T6
  out.push(
    { treatment: 'T6', operation: 't6_evaluate', name: 'Candidats par appel', value: 8, unit: 'candidats', origin: 'fixed', variable: null, role: 'lots successifs (pré-génération durable) ; évalué / reporté / non examiné tracés' },
    { treatment: 'T6', operation: 't6_evaluate', name: 'Faits par candidat', value: 8, unit: 'faits', origin: 'fixed', variable: null, role: 'empreinte v5 ; faits omis tracés' },
    { treatment: 'T6', operation: 't6_evaluate', name: 'Documents par candidat', value: 5, unit: 'documents', origin: 'fixed', variable: null, role: 'empreinte v5 ; documents omis tracés' },
    { treatment: 'T6', operation: 't6_formulate', name: 'Message', value: 420, unit: 'caractères', origin: 'fixed', variable: null, role: 'contrainte de présentation (FORMULATE seulement)' },
  );
  return out;
}
