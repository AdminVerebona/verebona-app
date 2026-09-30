/**
 * Réponses T2 depuis les données déjà présentes — niveaux 1 et 2 de la
 * cascade de non-escalade. Aucun appel modèle ici.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * `tryDeterministic()` ne savait que dire « il faut un retrieval simple »
 * (`needsSimpleRetrieval: true`). Après ce retrieval, l'orchestrateur ne
 * tentait AUCUNE réponse exacte : il passait au modèle si l'intention était
 * éligible, sinon répondait « Voici ce que j'ai trouvé dans votre compte ».
 *
 * Ce module est l'étape manquante :
 *
 *   routage → réponse exacte structurée (niveau 1)
 *           → réponse depuis les données T1 / recherche interne (niveau 2)
 *           → contrôle de suffisance explicite (seuils de gouvernance)
 *           → escalade vers le modèle SEULEMENT si insuffisant, avec motif
 *
 * Une réponse produite ici est une réponse T2 complète : AI calls = 0,
 * coût = 0, trace de la stratégie et de la décision de suffisance. Elle est
 * identique que l'IA soit disponible ou non.
 *
 * ── RÈGLE DES CALCULS ─────────────────────────────────────────────────────
 *
 * Comptes, sommes, écarts de dates, « prochaine échéance », filtres : tout
 * est calculé par le code. Le modèle ne reçoit jamais un calcul à faire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource, Claim } from '../types/sources';
import { findTableIntersection, type TableAnswer, type TableCellRow } from '@/services/ai/knowledge/document-tables';
import { parseFrDate } from '@/services/ai/agenda/rules/recurrence';
import { extractSearchTerms, isInventoryQuery } from './query-terms';
import {
  ANALYSIS_STATUS_LABELS, IN_ANALYSIS_MESSAGE, analysisFailedMessage, documentAnalysisStatus,
} from './document-status';
import { buildResultGroups, summarizeGroups, type ResultGroup } from './result-groups';
import { canonicalReadEnabled } from '../canonical/mode';
import { tryCanonicalStructured, fieldAnswer } from '../canonical/structured-answers';
import { assetFieldSource } from '../canonical/field-reader';
import { exportCodeLabel } from '@/services/exports/catalog';
import {
  daysBetween,
  formatAttributeValue,
  formatConflict,
  formatCount,
  formatDateFr,
  formatDeadline,
  formatList,
  formatNoResult,
  formatQuantity,
  formatRelativeDays,
  formatSum,
  joinFr,
} from './deterministic-format';
import {
  decideDocumentHit,
  decideFacts,
  decideStructured,
  requiresSynthesis,
  type CascadeThresholdsLike,
  type SufficiencyDecision,
} from './sufficiency';

// ── Port de données (implémenté par `account-data.repository.ts`) ──────────

export interface AssetRow {
  id: number;
  name: string;
  category: string;
  subtype: string | null;
  purchaseDate: string | null;
  /** Usage « Mis en location » de la fiche (seule donnée qui le dit). */
  isRented: boolean;
  /** Nombre de mots de la question retrouvés dans le bien (recherche). */
  matched?: number;
  /** Éléments distinctifs, pour présenter des candidats non ambigus. */
  city?: string | null;
  address?: string | null;
  registrationNumber?: string | null;
}

export interface AgendaRow {
  id: number;
  title: string;
  date: string;
  assetNames: string[];
  /** Occurrence prévisionnelle (récurrence calculée, pas encore confirmée). */
  forecast?: boolean;
}

export interface FactHit {
  id: number;
  fileId: number;
  factKey: string;
  subject: string | null;
  attribute: string | null;
  label: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueUnit: string | null;
  confidence: string;
  /** Extrait littéral ; vide pour une observation visuelle. */
  excerpt: string;
  documentTitle: string | null;
  matchedTerms: number;
  /** Lu dans le document, ou observé sur l'image (0161). */
  evidenceOrigin?: 'TEXT_EXTRACTION' | 'VISUAL_ANALYSIS';
  visualDescription?: string | null;
  page?: number | null;
  /**
   * CDC 15 T2-02 (ASSISTANT_CANONICAL_READ=enabled) : valeur CANONIQUE du
   * bien pour la clé du fait (registre), son origine et le conflit ouvert.
   * Elle prime sur le fait T1 (ordre de vérité §9).
   */
  canonical?: {
    assetId: number; key: string; label: string; value: string | null;
    origin: string | null; originLabel: string | null; openConflict: string | null;
  };
}

export interface DocumentHit {
  fileId: number;
  title: string;
  date: string | null;
  assetName: string | null;
  matchedTerms: number;
  snippet?: string;
  /** `asset_files.analysis_state` (§12.4, §23) — absent si inconnu. */
  analysisState?: string | null;
}

export interface AccountDataPort {
  /** Date du jour, ISO (fuseau Europe/Paris). */
  today(): string;
  findAssets(accountId: number, words: string[]): Promise<AssetRow[]>;
  listAssets(accountId: number, opts?: { family?: string; rented?: boolean }): Promise<AssetRow[]>;
  countDocuments(accountId: number, opts?: { assetIds?: number[] }): Promise<number>;
  countAgenda(accountId: number, opts?: { assetIds?: number[]; futureOnly?: boolean }): Promise<number>;
  upcomingAgenda(accountId: number, opts?: { assetIds?: number[]; terms?: string[]; limit?: number }): Promise<AgendaRow[]>;
  sumDocumentAmounts(accountId: number, opts?: { assetIds?: number[]; year?: number; terms?: string[] }): Promise<{ sumCents: number; count: number }>;
  searchFacts(accountId: number, terms: string[], assetId?: number | null): Promise<FactHit[]>;
  /** Cellules des tableaux T1 (lignes complètes) — facultatif. */
  searchTableCells?(accountId: number, terms: string[], assetId?: number | null): Promise<TableCellRow[]>;
  searchDocuments(accountId: number, terms: string[], assetId?: number | null): Promise<DocumentHit[]>;
  /** Documents rattachés à des biens, les plus récents d'abord. */
  listDocuments?(accountId: number, opts: { assetIds: number[]; limit?: number }): Promise<DocumentHit[]>;
  /** Un document du compte (non supprimé), pour son statut (§12.2). */
  findDocument?(accountId: number, fileId: number): Promise<DocumentHit | null>;
  /** Exports et dossiers générés, les plus récents d'abord (§12.1). */
  listExports?(accountId: number, opts: { assetIds?: number[]; limit?: number }): Promise<ExportRow[]>;
  // ── Lecture canonique (lot 15, ASSISTANT_CANONICAL_READ=enabled) ────────
  /** Champ canonique d'un bien : valeur, origine, preuve, conflit (T2-22). */
  readAssetField?(accountId: number, assetId: number, key: string): Promise<import('../canonical/field-reader').CanonicalFieldReading | null>;
  /** Dépenses qualifiées par thème (T2-24). */
  sumQualifiedExpenses?(accountId: number, opts: { assetIds?: number[]; year?: number; theme?: import('../canonical/expenses').ExpenseTheme | null }): Promise<import('../canonical/expenses').QualifiedExpenses>;
  /** Informations manquantes (registre + À traiter) (T2-04). */
  listMissingInformation?(accountId: number, opts: { assetIds?: number[] }): Promise<import('../canonical/completeness').AssetCompleteness[]>;
  /** Échéances à venir dans une fenêtre, HISTORICAL exclu (T2-15). */
  listUpcomingAgenda?(accountId: number, opts: { assetIds?: number[]; from?: string; windowDays?: number | null; limit?: number; terms?: string[] }): Promise<import('../canonical/agenda').UpcomingAgendaRow[]>;
}

/** Export ou dossier généré pour un bien (`export_generation`). */
export interface ExportRow {
  id: number;
  assetId: number;
  assetName: string | null;
  exportType: string;
  /** pending | generating | ready | error (les supprimés sont exclus). */
  status: string;
  /** Date de génération (ou de demande), ISO. */
  date: string | null;
}

// ── Résultat ───────────────────────────────────────────────────────────────

export type DataAnswerStrategy =
  | 'structured.count_documents'
  | 'structured.count_assets'
  | 'structured.count_agenda'
  | 'structured.next_deadline'
  | 'structured.deadline_of'
  | 'structured.purchase_date'
  | 'structured.list_rented'
  | 'structured.list_assets'
  | 'structured.sum_amounts'
  | 'structured.list_documents'
  | 'structured.document_status'
  | 'structured.exports'
  // Lecture canonique (lot 15, ASSISTANT_CANONICAL_READ=enabled).
  | 'structured.asset_field'
  | 'structured.upcoming_agenda'
  | 'structured.missing_information'
  | 'structured.sum_qualified'
  | 'retrieval.canonical_field'
  | 'retrieval.t1_fact'
  | 'retrieval.t1_table'
  | 'retrieval.document'
  | 'retrieval.document_status'
  | 'none';

export interface CascadeAttempt {
  level: 1 | 2;
  strategy: DataAnswerStrategy;
  status: SufficiencyDecision['status'];
  score: number;
  threshold: number;
  reason?: string;
}

export interface DataAnswerOutcome {
  /** Vrai si une réponse est prête sans modèle (suffisante ou conflit signalé). */
  handled: boolean;
  answer?: string;
  sources: RetrievedSource[];
  claims: Claim[];
  decision: SufficiencyDecision;
  strategy: DataAnswerStrategy;
  attempts: CascadeAttempt[];
  /** Sources T1 utiles au modèle si l'on escalade malgré tout. */
  contextSources: RetrievedSource[];
  /**
   * La demande vise UN bien et plusieurs correspondent aussi bien : aucune
   * réponse ne serait correcte sans choix de l'utilisateur. L'orchestrateur
   * en fait une clarification — ce module ne choisit jamais arbitrairement.
   */
  ambiguity?: { kind: 'asset'; reason: string; candidates: AssetRow[] };
  /**
   * Faits T1 utiles mais insuffisants (confiance trop faible, valeurs en
   * conflit) : l'orchestrateur peut demander une revalidation CIBLÉE de ces
   * faits — jamais une nouvelle analyse T1 complète.
   */
  revalidation?: { trigger: 'LOW_CONFIDENCE' | 'CONFLICT'; factIds: number[] };
  /**
   * Document pertinent trouvé, mais sans la réponse : en cours d'analyse,
   * analyse en échec, ou information absente (§12.4 — états distincts, jamais
   * fusionnés dans « aucun résultat »).
   */
  documentState?: { kind: 'IN_ANALYSIS' | 'ANALYSIS_FAILED' | 'FOUND_WITHOUT_INFO'; fileId: number; title: string };
}

// ── Analyse de la question ─────────────────────────────────────────────────

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const RE = {
  count: /\b(combien|nombre)\b/,
  documents: /\b(documents?|factures?|fichiers?|pieces?)\b/,
  assets: /\b(biens?|vehicules?|logements?|proprietes?)\b/,
  agenda: /\b(echeances?|rappels?|rendez-vous|evenements?|dates? importantes?)\b/,
  spend: /\b(depense|depenses|depensee?s?|coute|coutes?|paye|payes?|total|somme|montant total)\b/,
  next: /\bprochaine?s?\s+(echeance|date|rendez-vous|rappel|evenement|entretien|controle)s?\b/,
  deadlineOf: /\b(echeance|expire|expiration|expirera|renouvel\w*|arrive a echeance|fin de (contrat|garantie))\b/,
  purchase: /\b(date d.?achat|achete\w*|acquis\w*|date d.?acquisition)\b/,
  rented: /\b(en location|mis en location|loues?|louees?|location)\b/,
  findDoc: /\b(retrouve|retrouver|trouve|trouver|cherche|chercher|ou est|ou se trouve|montre|affiche|ouvre)\b/,
  year: /\b(20\d{2})\b/,
};

/** Mots d'une question qui décrivent CE QU'ON DEMANDE, pas l'objet visé. */
const QUESTION_NOUNS = new Set([
  'document', 'documents', 'facture', 'factures', 'fichier', 'fichiers', 'piece', 'pieces',
  'echeance', 'echeances', 'rappel', 'rappels', 'evenement', 'evenements', 'date', 'dates',
  'achat', 'acquisition', 'prochaine', 'prochain', 'lies', 'liee', 'lie', 'liees', 'rattache',
  'rattaches', 'rattachee', 'rattachees', 'associes', 'concernant', 'combien', 'nombre', 'total',
  'somme', 'depense', 'depenses', 'expire', 'expiration', 'renouvellement', 'quand', 'importantes',
  'retrouve', 'retrouver', 'trouve', 'trouver', 'cherche', 'chercher', 'ou', 'est', 'arrive',
  'location', 'loue', 'loues', 'louee', 'louees', 'mis', 'mise', 'biens', 'bien', 'rendez', 'vous', 'rendez-vous',
]);

const FAMILY_WORDS: Record<string, string> = {
  vehicule: 'VEHICULE', vehicules: 'VEHICULE', voiture: 'VEHICULE', voitures: 'VEHICULE',
  moto: 'VEHICULE', motos: 'VEHICULE', velo: 'VEHICULE', velos: 'VEHICULE', bateau: 'VEHICULE',
  immobilier: 'IMMOBILIER', logement: 'IMMOBILIER', logements: 'IMMOBILIER', maison: 'IMMOBILIER',
  maisons: 'IMMOBILIER', appartement: 'IMMOBILIER', appartements: 'IMMOBILIER',
  objet: 'OBJECT', objets: 'OBJECT',
};

function words(message: string): string[] {
  return plain(message).replace(/['’]/g, ' ').split(/[^a-z0-9-]+/).filter((w) => w.length >= 2);
}

/** Mots candidats pour désigner un bien (« mon appartement », « la Clio »). */
function assetWords(message: string): string[] {
  return words(message).filter((w) => !ASSET_STOPWORDS.has(w) && !QUESTION_NOUNS.has(w) && !/^\d+$/.test(w));
}

/**
 * Mots grammaticaux et verbes de question : ils ne désignent jamais un bien.
 * Liste volontairement large — un mot résiduel non reconnu fait escalader
 * (jamais répondre à l'échelle du compte), ce qui est le sens sûr.
 */
const ASSET_STOPWORDS = new Set([
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'notre', 'nos', 'votre', 'vos', 'son', 'sa', 'ses', 'leur', 'leurs',
  'le', 'la', 'les', 'l', 'de', 'des', 'du', 'd', 'a', 'au', 'aux', 'un', 'une', 'et', 'ou', 'ni', 'mais',
  'ce', 'cet', 'cette', 'ces', 'ci', 'ca', 'cela', 'ici', 'la-bas',
  'je', 'j', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'me', 'm', 'moi', 'y', 'en', 'se', 's',
  'ai', 'as', 'avons', 'avez', 'ont', 'ai-je', 'avais', 'avait', 'eu', 'suis', 'es', 'est', 'sommes', 'etes', 'sont', 'ete',
  'est-ce', 'qu', 'que', 'quoi', 'qui', 'quel', 'quelle', 'quels', 'quelles', 'lequel', 'laquelle',
  'pour', 'par', 'sur', 'sous', 'dans', 'avec', 'sans', 'chez', 'vers', 'depuis', 'entre', 'avant', 'apres', 'pendant',
  'tout', 'tous', 'toute', 'toutes', 'plus', 'moins', 'tres', 'deja', 'encore', 'reste', 'restent', 'venir',
  'annee', 'annees', 'an', 'ans', 'mois', 'jour', 'jours', 'semaine', 'aujourd', 'hui', 'cette',
  'depense', 'depenses', 'depensee', 'depensees', 'coute', 'coutes', 'paye', 'payes', 'payee', 'payees',
  'montant', 'montants', 'euros', 'euro', 'svp', 'stp', 'merci', 'bonjour', 'dis', 'dit', 'donne', 'donner',
  'peux', 'peut', 'pouvez', 'sais', 'savoir', 'voudrais', 'veux', 'faut', 'fait', 'faire', 'enregistre', 'enregistres',
  'enregistree', 'enregistrees', 'actuellement', 'total', 'avoir',
]);

/** Termes de recherche T1 (faits, texte) : discriminants, sans les mots de la question. */
function knowledgeTerms(message: string): string[] {
  const base = extractSearchTerms(message);
  // Les mots de catégorie (« maison », « voiture ») servent aussi à retrouver un fait.
  const cat = words(message).filter((w) => FAMILY_WORDS[w]);
  return [...new Set([...base, ...cat])].filter((t) => !QUESTION_NOUNS.has(t) && t.length >= 3);
}

function docSource(fileId: number, title: string, content: string, score = 1): RetrievedSource {
  return { id: `doc_${fileId}`, type: 'document', title, content: content.slice(0, 1500), relevanceScore: score, meta: { fileId } };
}
function assetSource(a: AssetRow): RetrievedSource {
  return { id: `asset_${a.id}`, type: 'asset_field', title: a.name, content: [a.category, a.subtype].filter(Boolean).join(' · '), relevanceScore: 1, meta: { assetId: a.id } };
}
function agendaSource(r: AgendaRow): RetrievedSource {
  return { id: `agenda_${r.id}`, type: 'agenda_item', title: r.title, content: `${r.date}${r.assetNames.length ? ` · ${r.assetNames.join(', ')}` : ''}`, relevanceScore: 1, meta: { date: r.date } };
}
function statusDocSource(d: DocumentHit): RetrievedSource {
  const st = documentAnalysisStatus(d.analysisState);
  return {
    ...docSource(d.fileId, d.title, d.snippet ?? ''),
    meta: { fileId: d.fileId, date: d.date, assetName: d.assetName, analysisStatus: st, statusLabel: ANALYSIS_STATUS_LABELS[st] },
  };
}
function exportSource(r: ExportRow): RetrievedSource {
  const lib = exportCodeLabel(r.exportType);
  return {
    id: `export_${r.id}`, type: 'export_item', title: lib, content: [r.assetName, r.date].filter(Boolean).join(' · '),
    relevanceScore: 1,
    meta: { assetId: r.assetId, assetName: r.assetName, date: r.date, exportType: r.exportType, statusLabel: EXPORT_STATUS_LABELS[r.status] ?? null },
  };
}
function claim(key: string, text: string, sources: RetrievedSource[], derivation: Claim['derivation']): Claim {
  return { claimKey: key, text, sourceIds: sources.map((s) => s.id), derivation };
}

/**
 * Nom d'affichage d'un bien : complété de la ville quand un autre bien porte
 * le même nom (« Maison (Lyon) » / « Maison (Annecy) »), ou quand il n'y a
 * qu'un bien mais qu'il est situé.
 */
function assetDisplayName(a: AssetRow, among: AssetRow[] = []): string {
  const homonyme = among.some((o) => o.id !== a.id && plain(o.name) === plain(a.name));
  const detail = a.city ?? a.registrationNumber ?? null;
  return detail && (homonyme || among.length === 0) ? `${a.name} (${detail})` : a.name;
}

// ── Résolution du bien visé ────────────────────────────────────────────────

interface AssetScope {
  assets: AssetRow[];
  /** Plusieurs biens aussi pertinents : la réponse les détaille. */
  ambiguous: boolean;
  /**
   * La question désigne un bien que l'on n'a pas retrouvé (« pour ma Clio »
   * sans Clio au compte) : on ne répond PAS à l'échelle du compte entier.
   */
  unresolved: boolean;
  label: string | null;
}

async function resolveAssetScope(
  port: AccountDataPort,
  accountId: number,
  message: string,
  pageAssetId: number | null,
  resolvedAssetId: number | null = null,
): Promise<AssetScope> {
  // Choix fait par l'utilisateur lors d'une clarification : il fait foi, à
  // condition que le bien soit toujours au compte et accessible.
  if (resolvedAssetId) {
    const a = (await port.listAssets(accountId)).find((x) => x.id === resolvedAssetId);
    return a
      ? { assets: [a], ambiguous: false, unresolved: false, label: a.name }
      : { assets: [], ambiguous: false, unresolved: true, label: null };
  }
  const candidates = assetWords(message);
  if (candidates.length > 0) {
    const found = await port.findAssets(accountId, candidates);
    if (found.length > 0) {
      const best = Math.max(...found.map((a) => a.matched ?? 1));
      const top = found.filter((a) => (a.matched ?? 1) === best);
      return { assets: top, ambiguous: top.length > 1, unresolved: false, label: top.length === 1 ? top[0].name : null };
    }
  }
  // « cet appartement » depuis la fiche d'un bien : le contexte de page tranche.
  if (pageAssetId && /\b(ce|cet|cette|ici)\b/.test(plain(message))) {
    const all = await port.listAssets(accountId);
    const a = all.find((x) => x.id === pageAssetId);
    if (a) return { assets: [a], ambiguous: false, unresolved: false, label: a.name };
  }
  return { assets: [], ambiguous: false, unresolved: candidates.length > 0, label: null };
}

// ── Niveau 1 : réponses structurées ────────────────────────────────────────

type Level1 = { strategy: DataAnswerStrategy; answer: string; sources: RetrievedSource[]; claims: Claim[]; kind: Parameters<typeof decideStructured>[0] } | null;
/** Plusieurs biens également plausibles pour une demande qui n'en vise qu'un. */
type Ambiguous = { ambiguous: AssetRow[]; reason: string };

/** Demande de liste des documents d'un bien (« montre-moi les documents de ma maison »). */
const LIST_DOCS = /\b(montre|affiche|liste|lister|quels? sont|donne)\b/;

/**
 * Question DIRECTE sur le statut d'un document (§12.2) : « quel est le
 * statut de ce document ? », « où en est l'analyse de ma facture EDF ? »,
 * « ma facture est-elle analysée ? ».
 */
export const DOCUMENT_STATUS_QUESTION = /\b(statut|etat)\s+(de|du|d'|des)\b|\bou en est\b|\best-(il|elle) (bien )?analyse|\ba-t-(il|elle) ete analyse|\bdeja ete analyse|\b(analyse|analysee) (est-elle|est elle) terminee/;

/** Liste des exports et dossiers disponibles (§12.1). */
const EXPORTS_QUESTION = /\b(exports?|dossiers?)\b/;
const EXPORTS_LIST = /\b(quels?|quelles?|mes|liste|lister|montre|affiche|disponibles?|generes?|prets?|ai-je|j'ai)\b/;

const EXPORT_WORDS = new Set([
  'export', 'exports', 'dossier', 'dossiers', 'disponible', 'disponibles', 'genere', 'generes', 'generee', 'generees',
  'pret', 'prets', 'prete', 'pretes', 'liste', 'lister', 'montre', 'affiche', 'deja', 'faits', 'prepare', 'prepares',
]);

const EXPORT_STATUS_LABELS: Record<string, string> = {
  ready: 'prêt', pending: 'en attente de génération', generating: 'en cours de génération', error: 'en erreur',
};

/** Libellé du statut d'analyse, pour une réponse directe (§12.2, §23.1). */
function statutDocumentPhrase(d: DocumentHit): string {
  const st = documentAnalysisStatus(d.analysisState);
  switch (st) {
    case 'IN_ANALYSIS': return `Statut de « ${d.title} » : en cours d’analyse. Certaines informations peuvent ne pas être disponibles immédiatement.`;
    case 'ANALYSIS_FAILED': return `Statut de « ${d.title} » : analyse impossible. ${analysisFailedMessage(d.title)}`;
    case 'TO_VALIDATE': return `Statut de « ${d.title} » : analysé, des informations sont à vérifier (voir « À traiter »).`;
    case 'ANALYZED': return `Statut de « ${d.title} » : analysé.`;
    default: return `Statut de « ${d.title} » : enregistré, sans analyse automatique.`;
  }
}

async function tryStructured(
  port: AccountDataPort,
  accountId: number,
  message: string,
  pageAssetId: number | null,
  resolvedAssetId: number | null = null,
  pageDocumentId: number | null = null,
): Promise<Level1 | Ambiguous> {
  const m = plain(message);
  const today = port.today();
  const scopeOf = () => resolveAssetScope(port, accountId, message, pageAssetId, resolvedAssetId);

  // ── Statut d'un document, en question directe (§12.2) ──────────────────
  // Le document de la page (ou désigné par le fil / une clarification) fait
  // foi ; sinon, le document le plus pertinent pour les termes de la
  // question — jamais un document choisi au hasard.
  if (DOCUMENT_STATUS_QUESTION.test(m) && (RE.documents.test(m) || /\b(analyse|ce document|ce fichier)\b/.test(m) || pageDocumentId)) {
    let doc: DocumentHit | null = null;
    if (pageDocumentId && port.findDocument) doc = await port.findDocument(accountId, pageDocumentId).catch(() => null);
    if (!doc) {
      const terms = knowledgeTerms(message).filter((t) => !['statut', 'etat', 'analyse', 'analysee', 'terminee'].includes(t));
      if (terms.length) {
        const hits = await port.searchDocuments(accountId, terms, null).catch(() => [] as DocumentHit[]);
        const best = Math.max(0, ...hits.map((h) => h.matchedTerms));
        const top = hits.filter((h) => h.matchedTerms === best && best > 0);
        // Plusieurs documents également plausibles : pas de statut au hasard,
        // la liste est donnée avec le statut de chacun.
        if (top.length > 1) {
          const answer = formatList('Statut des documents correspondants', top.slice(0, 5).map((d) => {
            const lib = ANALYSIS_STATUS_LABELS[documentAnalysisStatus(d.analysisState)] ?? 'Analysé ou enregistré';
            return `« ${d.title} » : ${lib.toLowerCase()}`;
          }));
          const sources = top.slice(0, 5).map((d) => statusDocSource(d));
          return { strategy: 'structured.document_status', answer, sources, claims: [claim('document_status', answer, sources, 'direct')], kind: 'list' };
        }
        doc = top[0] ?? null;
      }
    }
    if (doc) {
      const answer = statutDocumentPhrase(doc);
      const sources = [statusDocSource(doc)];
      return { strategy: 'structured.document_status', answer, sources, claims: [claim('document_status', answer, sources, 'direct')], kind: 'exact' };
    }
  }

  // ── Exports et dossiers disponibles (§12.1) ────────────────────────────
  if (EXPORTS_QUESTION.test(m) && EXPORTS_LIST.test(m) && !/\bcomment\b/.test(m) && port.listExports) {
    // Les mots de la question (« exports disponibles ») ne désignent pas un
    // bien : sans autre mot, la liste porte sur tout le compte.
    const autresMots = assetWords(message).filter((w) => !EXPORT_WORDS.has(w));
    const scope = autresMots.length === 0
      ? { assets: [] as AssetRow[], ambiguous: false, unresolved: false, label: null as string | null }
      : await scopeOf();
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'EXPORTS_MULTIPLE_ASSETS' };
    if (!scope.unresolved) {
      const rows = await port.listExports(accountId, { assetIds: scope.assets.map((a) => a.id), limit: 10 });
      const pour = scope.label ? `pour ${scope.label}` : undefined;
      const answer = rows.length === 0
        ? formatNoResult('aucun export ni dossier généré', pour) + ' Vous pouvez en préparer un depuis l’onglet « Exports » d’un bien.'
        : formatList(`Exports et dossiers${scope.label ? ` de ${scope.label}` : ''}`, rows.map((r) => {
          const lib = exportCodeLabel(r.exportType);
          return `${lib}${r.assetName && !scope.label ? ` (${r.assetName})` : ''}${r.date ? `, ${formatDateFr(r.date)}` : ''} : ${EXPORT_STATUS_LABELS[r.status] ?? r.status}`;
        }), 10);
      const sources = rows.length ? rows.map(exportSource) : scope.assets.map(assetSource);
      return { strategy: 'structured.exports', answer, sources, claims: [claim('exports', answer, sources, 'direct')], kind: rows.length ? 'list' : 'no_result' };
    }
  }

  // Documents d'un bien : la liste n'a de sens que pour UN bien. Deux biens
  // aussi plausibles → clarification ; aucun terme discriminant autre que le
  // bien → liste exacte, sans recherche textuelle.
  if (RE.documents.test(m) && LIST_DOCS.test(m) && !RE.count.test(m) && port.listDocuments) {
    const scope = await scopeOf();
    const autres = knowledgeTerms(message).filter((t) => !FAMILY_WORDS[t]
      && !scope.assets.some((a) => plain(a.name).includes(t) || plain(a.subtype ?? '') === t));
    if (scope.assets.length > 0 && autres.length === 0) {
      if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'LIST_DOCUMENTS_MULTIPLE_ASSETS' };
      const a = scope.assets[0];
      const nom = assetDisplayName(a);
      const docs = await port.listDocuments(accountId, { assetIds: [a.id], limit: 10 });
      const answer = docs.length === 0
        ? formatNoResult('aucun document', `pour ${nom}`)
        : formatList(`Documents de ${nom}`, docs.map((d) => `« ${d.title} »${d.date ? ` (${formatDateFr(d.date)})` : ''}`), 10);
      const sources = docs.length ? docs.map((d) => docSource(d.fileId, d.title, d.snippet ?? '')) : [assetSource(a)];
      return { strategy: 'structured.list_documents', answer, sources, claims: [claim('list', answer, sources, 'direct')], kind: docs.length ? 'list' : 'no_result' };
    }
  }

  // ── Lecture canonique (CDC 15 §9, lot 15) ──────────────────────────────
  // ASSISTANT_CANONICAL_READ=enabled : champ du registre (valeur, origine,
  // preuve, conflit), échéances à venir sur une fenêtre, informations
  // manquantes, dépenses QUALIFIÉES. Sinon : branches historiques, inchangées.
  if (canonicalReadEnabled()) {
    const c = await tryCanonicalStructured({
      port, accountId, message,
      resolveScope: (texte) => resolveAssetScope(port, accountId, texte, pageAssetId, resolvedAssetId),
    });
    if (c) return c;
  }

  // Somme de montants (« combien ai-je dépensé pour la maison en 2025 ? »).
  if (RE.spend.test(m) && (RE.count.test(m) || /\b(total|somme)\b/.test(m))) {
    const scope = await scopeOf();
    if (scope.unresolved) return null;
    const year = Number(m.match(RE.year)?.[1]) || undefined;
    const r = await port.sumDocumentAmounts(accountId, { assetIds: scope.assets.map((a) => a.id), year });
    const libelle = `total des montants de vos documents${scope.label ? ` pour ${scope.label}` : ''}${year ? ` en ${year}` : ''}`;
    const answer = r.count === 0 ? formatNoResult(`aucun montant enregistré`, scope.label ? `pour ${scope.label}` : undefined) : formatSum(libelle, r.sumCents, r.count);
    const sources = scope.assets.map(assetSource);
    return { strategy: 'structured.sum_amounts', answer, sources, claims: [claim('sum', answer, sources, 'calculated')], kind: r.count ? 'calc' : 'no_result' };
  }

  // Compteurs.
  if (RE.count.test(m)) {
    if (RE.documents.test(m)) {
      const scope = await scopeOf();
      if (scope.unresolved) return null;
      if (scope.ambiguous) {
        const parts = await Promise.all(scope.assets.map(async (a) => `${assetDisplayName(a, scope.assets)} : ${await port.countDocuments(accountId, { assetIds: [a.id] })}`));
        const answer = formatList('Nombre de documents par bien', parts);
        const sources = scope.assets.map(assetSource);
        return { strategy: 'structured.count_documents', answer, sources, claims: [claim('count', answer, sources, 'calculated')], kind: 'count' };
      }
      const n = await port.countDocuments(accountId, { assetIds: scope.assets.map((a) => a.id) });
      const answer = formatCount('document', n, scope.label ? `liés à ${scope.label}` : undefined);
      const sources = scope.assets.map(assetSource);
      return { strategy: 'structured.count_documents', answer, sources, claims: [claim('count', answer, sources, 'calculated')], kind: 'count' };
    }
    if (RE.agenda.test(m)) {
      const scope = await scopeOf();
      if (scope.unresolved) return null;
      const n = await port.countAgenda(accountId, { assetIds: scope.assets.map((a) => a.id), futureOnly: true });
      const answer = formatCount('échéance', n, `à venir${scope.label ? ` pour ${scope.label}` : ''}`);
      // CA-24 : un comptage est une affirmation CALCULÉE, tracée avec ses
      // sources (le bien visé) ou, à l'échelle du compte, sans source.
      const sources = scope.assets.map(assetSource);
      return { strategy: 'structured.count_agenda', answer, sources, claims: [claim('count', answer, sources, 'calculated')], kind: 'count' };
    }
    if (RE.assets.test(m) || words(m).some((w) => FAMILY_WORDS[w])) {
      const family = words(m).map((w) => FAMILY_WORDS[w]).find(Boolean);
      const list = await port.listAssets(accountId, { family });
      const answer = formatCount('bien', list.length, family === 'VEHICULE' ? '(véhicules)' : family === 'IMMOBILIER' ? '(immobilier)' : family === 'OBJECT' ? '(objets)' : undefined);
      const sources = list.slice(0, 8).map(assetSource);
      return { strategy: 'structured.count_assets', answer, sources, claims: [claim('count', answer, sources, 'calculated')], kind: 'count' };
    }
  }

  // Biens mis en location.
  if (RE.rented.test(m) && (RE.assets.test(m) || /\bquels?\b/.test(m))) {
    const list = await port.listAssets(accountId, { rented: true });
    const answer = list.length === 0
      ? formatNoResult('aucun bien dont l’usage est « Mis en location »')
      : formatList(`Vous avez ${list.length} bien${list.length > 1 ? 's' : ''} mis en location`, list.map((a) => a.name));
    const sources = list.slice(0, 8).map(assetSource);
    return { strategy: 'structured.list_rented', answer, sources, claims: [claim('list', answer, sources, 'direct')], kind: list.length ? 'list' : 'no_result' };
  }

  // Prochaine échéance (tri des dates, première à venir).
  if (RE.next.test(m)) {
    const scope = await scopeOf();
    if (scope.unresolved) return null;
    // « Les prochains travaux de ma maison » avec deux maisons : répondre sur
    // l'une ou mélanger les deux serait faux — on demande laquelle.
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'NEXT_DEADLINE_MULTIPLE_ASSETS' };
    const rows = await port.upcomingAgenda(accountId, { assetIds: scope.assets.map((a) => a.id), limit: 3 });
    if (rows.length === 0) {
      const answer = formatNoResult('aucune échéance à venir', scope.label ? `pour ${scope.label}` : undefined);
      // CA-24 : l'absence d'échéance est elle aussi un résultat calculé.
      const sources = scope.assets.map(assetSource);
      return { strategy: 'structured.next_deadline', answer, sources, claims: [claim('next', answer, sources, 'calculated')], kind: 'no_result' };
    }
    const [first, ...others] = rows;
    const bien = first.assetNames.length ? ` (${joinFr(first.assetNames)})` : '';
    // Une date prévisionnelle n'est jamais présentée comme confirmée.
    const le = (r: AgendaRow) => (r.forecast ? 'prévue le' : 'le');
    let answer = `Votre prochaine échéance : « ${first.title} »${bien}, ${le(first)} ${formatDateFr(first.date)} (${formatRelativeDays(daysBetween(today, first.date))}).`;
    if (first.forecast) answer += ' Cette date est prévisionnelle : elle sera confirmée par un document.';
    if (others.length) answer += ` Ensuite : ${joinFr(others.map((o) => `« ${o.title} » ${le(o)} ${formatDateFr(o.date)}`))}.`;
    const sources = rows.map(agendaSource);
    return { strategy: 'structured.next_deadline', answer, sources, claims: [claim('next', answer, sources.slice(0, 1), 'calculated')], kind: 'exact' };
  }

  // Date d'achat d'un bien (champ exact).
  if (RE.purchase.test(m)) {
    const scope = await scopeOf();
    if (scope.assets.length > 0) {
      const known = scope.assets.filter((a) => a.purchaseDate);
      // Sans date enregistrée, le niveau 2 (documents) peut encore la trouver.
      if (known.length === 0) return null;
      const answer = known.length === 1
        ? `Vous avez acheté ${known[0].name} le ${formatDateFr(known[0].purchaseDate)}.`
        : formatList('Dates d’achat enregistrées', known.map((a) => `${a.name} : ${formatDateFr(a.purchaseDate)}`));
      const sources = known.map(assetSource);
      return { strategy: 'structured.purchase_date', answer, sources, claims: [claim('purchase', answer, sources, 'direct')], kind: 'exact' };
    }
  }

  // Échéance d'un élément précis (« quand expire mon assurance habitation ? »).
  if (RE.deadlineOf.test(m)) {
    const terms = knowledgeTerms(message);
    if (terms.length > 0) {
      const scope = await scopeOf();
      if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'DEADLINE_MULTIPLE_ASSETS' };
      const rows = await port.upcomingAgenda(accountId, { assetIds: scope.assets.map((a) => a.id), terms, limit: 5 });
      if (rows.length > 0) {
        // Même échéance portée par plusieurs éléments à des dates différentes : conflit.
        const sameTitle = rows.filter((r) => plain(r.title) === plain(rows[0].title));
        const distinctDates = [...new Set(sameTitle.map((r) => r.date))];
        if (distinctDates.length > 1) {
          const answer = formatConflict(`« ${rows[0].title} »`, sameTitle.map((r) => ({ value: formatDateFr(r.date), source: r.assetNames.join(', ') || 'agenda' })));
          const sources = sameTitle.map(agendaSource);
          // CA-24 : le conflit est tracé comme une affirmation directe citant
          // chacune des sources en désaccord.
          return { strategy: 'structured.deadline_of', answer, sources, claims: [claim('conflict', answer, sources, 'direct')], kind: 'conflict' };
        }
        const first = rows[0];
        const label = `votre ${terms.join(' ')}`;
        const answer = formatDeadline(label, first.date, today) + (first.title && plain(first.title) !== plain(terms.join(' ')) ? ` Élément d’agenda : « ${first.title} ».` : '')
          + (first.forecast ? ' Cette date est prévisionnelle, calculée à partir de la récurrence : elle n’est pas encore confirmée.' : '');
        const sources = [agendaSource(first)];
        return { strategy: 'structured.deadline_of', answer, sources, claims: [claim('deadline', answer, sources, 'direct')], kind: 'exact' };
      }
      // Rien dans l'agenda : les documents (niveau 2) peuvent porter la date.
      return null;
    }
  }

  // Inventaire (« quels sont mes biens ? », « mes véhicules »).
  if (isInventoryQuery(message)) {
    const family = words(m).map((w) => FAMILY_WORDS[w]).find(Boolean);
    const list = await port.listAssets(accountId, { family: family && /\b(vehicules?|voitures?|immobilier|logements?|objets?)\b/.test(m) ? family : undefined });
    const answer = list.length === 0
      ? formatNoResult('aucun bien enregistré')
      : formatList(`Vous avez ${list.length} bien${list.length > 1 ? 's' : ''}`, list.map((a) => a.name));
    const sources = list.slice(0, 8).map(assetSource);
    return { strategy: 'structured.list_assets', answer, sources, claims: [claim('list', answer, sources, 'direct')], kind: list.length ? 'list' : 'no_result' };
  }

  return null;
}

// ── Niveau 2 : données T1 et recherche interne ─────────────────────────────

function comparableOf(f: FactHit): string {
  if (f.valueNumber !== null && f.valueNumber !== undefined && (f.valueUnit || !f.valueText)) return `${Number(f.valueNumber)}|${(f.valueUnit ?? '').toLowerCase()}`;
  return plain(f.valueText ?? '').trim();
}

// ══════════════════════════════════════════════════════════════════════════
// CITATION ≠ OBSERVATION
//
// Un fait lu se cite entre guillemets (« Puissance nominale : 24 kW »). Un fait
// observé sur une image n'a pas de citation : il est présenté comme une
// observation de l'analyse, pour que l'utilisateur ne prenne jamais une
// interprétation de photo pour un texte du document.
// ══════════════════════════════════════════════════════════════════════════
const isVisual = (f: FactHit) => f.evidenceOrigin === 'VISUAL_ANALYSIS';
const lowerFirst = (t: string) => t.trim().replace(/^./, (c) => c.toLowerCase());

export function evidenceText(f: FactHit): string {
  if (isVisual(f)) {
    const ou = f.page ? ` (page ${f.page})` : '';
    return `Observation visuelle${ou}, non écrite dans le document : ${f.visualDescription ?? f.valueText ?? ''}`;
  }
  return `« ${f.excerpt} »`;
}

function tableWhere(a: TableAnswer): string {
  const c = a.cell;
  const tableau = c.tableTitle ? `tableau « ${c.tableTitle} »` : 'tableau';
  return `${tableau}${c.page ? `, page ${c.page}` : ''}, ligne « ${a.rowLabel} », colonne « ${(c.columnPath.length > 1 ? c.columnPath.join(' > ') : c.columnHeader) ?? ''} »`;
}

function tableSource(a: TableAnswer, score = 1): RetrievedSource {
  const ctx = a.rowContext.length ? ` (${a.rowContext.map((o) => `${o.header} : ${o.value}`).join(' ; ')})` : '';
  return docSource(a.cell.fileId, a.cell.documentTitle ?? 'Document', `${tableWhere(a)} : ${a.cell.value === null ? '(cellule vide)' : `« ${a.cell.value} »`}${ctx}`, score);
}

/** La valeur, sa ligne, sa colonne et le reste de la ligne — jamais la valeur seule. */
function formatTableAnswer(a: TableAnswer): string {
  const c = a.cell;
  const autres = a.rowContext.filter((o) => o.value !== a.rowLabel);
  const ctx = autres.length ? ` Même ligne : ${autres.map((o) => `${o.header} : ${o.value}`).join(' ; ')}.` : '';
  const col = (c.columnPath.length > 1 ? c.columnPath.join(' > ') : c.columnHeader) ?? 'Valeur';
  const tableau = c.tableTitle ? `tableau « ${c.tableTitle} »` : 'tableau';
  return `${col} pour « ${a.rowLabel} » : ${c.value} (${tableau}${c.page ? `, page ${c.page}` : ''}, document « ${c.documentTitle ?? 'document'} »).${ctx}`;
}

function factSnippet(f: FactHit): string {
  return `${f.subject ?? ''} ${f.attribute ?? f.factKey} : ${displayValue(f)} — ${evidenceText(f)}`;
}

function displayValue(f: FactHit): string {
  // Sans unité, le texte d'origine fait foi (« 7723001 » ne devient pas « 7 723 001 »).
  if (!f.valueUnit && f.valueText) return f.valueText;
  return formatQuantity(f.valueNumber ?? f.valueText, f.valueUnit);
}

/** Fait candidat à une revalidation ciblée (visuel : seulement si VISUAL_RECHECK est possible). */
const revalidable = (f: FactHit, visuels: boolean) => !isVisual(f) || visuels;

/** VISUAL_RECHECK possible : T2 en architecture `master` (config versionnée). Ne lève jamais. */
async function visualRecheckEnabled(): Promise<boolean> {
  try {
    const { getPromptArchitecture } = await import('@/services/ai/config/config-resolver');
    return (await getPromptArchitecture('T2')) === 'master';
  } catch {
    return false;
  }
}

// ── Point d'entrée ─────────────────────────────────────────────────────────

export async function answerFromData(p: {
  port: AccountDataPort;
  accountId: number;
  message: string;
  pageAssetId?: number | null;
  /** Document de la page, ou désigné par le fil ou une clarification (§12.2). */
  pageDocumentId?: number | null;
  /** Bien fixé par une clarification (reprise structurée). */
  resolvedAssetId?: number | null;
  thresholds: CascadeThresholdsLike;
  /** Faux pour une recherche de document explicite : on privilégie le niveau 2 document. */
  intent?: string;
}): Promise<DataAnswerOutcome> {
  const attempts: CascadeAttempt[] = [];
  const contextSources: RetrievedSource[] = [];
  const noAnswer = (decision: SufficiencyDecision, strategy: DataAnswerStrategy = 'none'): DataAnswerOutcome => ({
    handled: false, sources: [], claims: [], decision, strategy, attempts, contextSources,
  });

  // Une demande de synthèse n'est pas « résolue » par une valeur exacte.
  // « Où en est l'analyse de ma facture ? » n'en est pas une : c'est le
  // statut d'un document (§12.2), lu tel quel.
  if (requiresSynthesis(p.message) && !DOCUMENT_STATUS_QUESTION.test(plain(p.message))) {
    const decision: SufficiencyDecision = { status: 'INSUFFICIENT', level: 1, score: 0, threshold: p.thresholds.database, reason: 'SYNTHESIS_REQUIRED' };
    attempts.push({ level: 1, strategy: 'none', status: decision.status, score: 0, threshold: decision.threshold, reason: decision.reason });
    // Les données T1 restent utiles au modèle : on les rassemble quand même.
    const terms = knowledgeTerms(p.message);
    if (terms.length) {
      const facts = await p.port.searchFacts(p.accountId, terms, null).catch(() => []);
      for (const f of facts.slice(0, 6)) contextSources.push(docSource(f.fileId, f.documentTitle ?? 'Document', factSnippet(f), 0.7));
    }
    return noAnswer(decision);
  }

  // ── Niveau 1 ─────────────────────────────────────────────────────────────
  const l1r = await tryStructured(p.port, p.accountId, p.message, p.pageAssetId ?? null, p.resolvedAssetId ?? null, p.pageDocumentId ?? null);
  if (l1r && 'ambiguous' in l1r) {
    const decision: SufficiencyDecision = { status: 'INSUFFICIENT', level: 1, score: 0, threshold: p.thresholds.database, reason: 'AMBIGUOUS_TARGET', detail: `${l1r.ambiguous.length} biens` };
    attempts.push({ level: 1, strategy: 'none', status: decision.status, score: 0, threshold: decision.threshold, reason: decision.reason });
    return { ...noAnswer(decision), ambiguity: { kind: 'asset', reason: l1r.reason, candidates: l1r.ambiguous } };
  }
  const l1 = l1r;
  if (l1) {
    const decision = decideStructured(l1.kind, p.thresholds);
    attempts.push({ level: 1, strategy: l1.strategy, status: decision.status, score: decision.score, threshold: decision.threshold, reason: decision.reason });
    if (decision.status === 'SUFFICIENT_STRUCTURED' || decision.status === 'CONFLICTING') {
      return { handled: true, answer: l1.answer, sources: l1.sources, claims: l1.claims, decision, strategy: l1.strategy, attempts, contextSources };
    }
    contextSources.push(...l1.sources);
  } else {
    attempts.push({ level: 1, strategy: 'none', status: 'NOT_APPLICABLE', score: 0, threshold: p.thresholds.database, reason: 'NO_STRUCTURED_PLAN' });
  }

  // ── Niveau 2 : faits T1 ──────────────────────────────────────────────────
  const terms = knowledgeTerms(p.message);
  if (terms.length === 0) {
    return noAnswer({ status: 'INSUFFICIENT', level: 2, score: 0, threshold: p.thresholds.text, reason: 'NO_RESULT', detail: 'aucun terme discriminant' });
  }
  const scope = await resolveAssetScope(p.port, p.accountId, p.message, p.pageAssetId ?? null, p.resolvedAssetId ?? null);
  const scopedAssetId = scope.assets.length === 1 ? scope.assets[0].id : null;
  // Recherche d'un fait ou d'un document « de ma maison » avec deux maisons :
  // chercher dans les deux mélangerait leurs documents. L'ambiguïté la plus
  // structurante (le bien) est levée d'abord ; le reste suit à la reprise.
  if (scope.ambiguous) {
    const decision: SufficiencyDecision = { status: 'INSUFFICIENT', level: 2, score: 0, threshold: p.thresholds.text, reason: 'AMBIGUOUS_TARGET', detail: `${scope.assets.length} biens` };
    attempts.push({ level: 2, strategy: 'none', status: decision.status, score: 0, threshold: decision.threshold, reason: decision.reason });
    return { ...noAnswer(decision), ambiguity: { kind: 'asset', reason: 'SEARCH_MULTIPLE_ASSETS', candidates: scope.assets } };
  }

  const wantsDocument = RE.findDoc.test(plain(p.message)) || p.intent === 'ACCOUNT_SEARCH_DOCUMENT';

  // ── Niveau 2 : intersection ligne / colonne d'un tableau T1 ─────────────
  // « Quel était le kilométrage de la Clio au 3 septembre 2026 ? » : la
  // colonne (Kilométrage) et la ligne (Clio, 03/09/2026) désignent UNE
  // cellule. Réponse directe seulement si la cellule est unique et sûre.
  if (!wantsDocument && p.port.searchTableCells) {
    const cells = await p.port.searchTableCells(p.accountId, terms, scopedAssetId).catch(() => [] as TableCellRow[]);
    if (cells.length > 0) {
      const dates = [parseFrDate(p.message)].filter((d): d is string => !!d);
      const { answer: hit, ambiguous, empty } = findTableIntersection(cells, terms, dates);
      if (empty && !empty.cell.tableUncertain) {
        // La cellule désignée existe et est vide : c'est la réponse — pas la
        // valeur d'une autre ligne ou d'une autre colonne.
        const answer = `Le ${tableWhere(empty)} de « ${empty.cell.documentTitle ?? 'document'} » ne contient aucune valeur (cellule vide).`;
        const sources = [tableSource(empty)];
        const decision: SufficiencyDecision = { status: 'SUFFICIENT_RETRIEVAL', level: 2, score: 1, threshold: p.thresholds.text };
        attempts.push({ level: 2, strategy: 'retrieval.t1_table', status: decision.status, score: 1, threshold: decision.threshold, reason: 'EMPTY_CELL' });
        return { handled: true, answer, sources, claims: [claim('table_cell', answer, sources, 'direct')], decision, strategy: 'retrieval.t1_table', attempts, contextSources };
      }
      const sure = hit && !hit.cell.tableUncertain && hit.cell.confidence === 'certain';
      attempts.push({
        level: 2, strategy: 'retrieval.t1_table',
        status: sure ? 'SUFFICIENT_RETRIEVAL' : 'INSUFFICIENT', score: sure ? 1 : 0, threshold: p.thresholds.text,
        reason: sure ? undefined : ambiguous.length ? 'AMBIGUOUS_TARGET' : hit ? 'LOW_CONFIDENCE' : 'NO_RESULT',
      });
      for (const a of (hit ? [hit] : ambiguous).slice(0, 4)) contextSources.push(tableSource(a, 0.7));
      if (sure) {
        const answer = formatTableAnswer(hit);
        const sources = [tableSource(hit)];
        const decision: SufficiencyDecision = { status: 'SUFFICIENT_RETRIEVAL', level: 2, score: 1, threshold: p.thresholds.text };
        return { handled: true, answer, sources, claims: [claim('table_cell', answer, sources, 'direct')], decision, strategy: 'retrieval.t1_table', attempts, contextSources };
      }
    }
  }

  if (!wantsDocument) {
    const facts = await p.port.searchFacts(p.accountId, terms, scopedAssetId);

    // CDC 15 T2-02 (enabled) : un fait qui porte une clé du registre cède la
    // place à la VALEUR CANONIQUE du bien (fiche, arbitrage T3), avec son
    // origine et le conflit ouvert — jamais remise en cause par un document.
    if (canonicalReadEnabled() && p.port.readAssetField && facts.length) {
      const top = Math.max(...facts.map((f) => f.matchedTerms));
      const c = facts.find((f) => f.matchedTerms === top && f.canonical?.value);
      const r = c?.canonical ? await p.port.readAssetField(p.accountId, c.canonical.assetId, c.canonical.key) : null;
      if (r && r.display !== null) {
        const src = assetFieldSource(r);
        const autres = facts.filter((f) => f.canonical?.key === r.key && plain(displayValue(f)) !== plain(r.display ?? ''));
        const answer = fieldAnswer(r) + (autres.length && !r.openConflict
          ? ` ${joinFr([...new Set(autres.map((f) => `« ${f.documentTitle ?? 'un document'} »`))])} indique une autre valeur (${displayValue(autres[0])}) : la valeur de votre fiche fait foi.`
          : '');
        const decision: SufficiencyDecision = { status: 'SUFFICIENT_STRUCTURED', level: 2, score: 1, threshold: p.thresholds.text, detail: 'valeur canonique' };
        attempts.push({ level: 2, strategy: 'retrieval.canonical_field', status: decision.status, score: 1, threshold: decision.threshold });
        const sources = [src, ...autres.slice(0, 2).map((f) => docSource(f.fileId, f.documentTitle ?? 'Document', evidenceText(f)))];
        return { handled: true, answer, sources, claims: [claim(`field:${r.key}`, answer, [src], 'direct')], decision, strategy: 'retrieval.canonical_field', attempts, contextSources };
      }
    }

    // CDC 15 T2-30 (lot 15, besoin de Z) : en architecture T2 `master`, une
    // observation VISUELLE peut être revalidée (VISUAL_RECHECK, sans citation
    // fabriquée) ; en `steps`, seuls les faits lus le sont, comme avant.
    const visuelsRevalidables = facts.some(isVisual) && await visualRecheckEnabled();
    const decision = decideFacts(
      facts.map((f) => ({ comparable: comparableOf(f), confidence: f.confidence, matchedTerms: f.matchedTerms, sourceKey: `doc_${f.fileId}` })),
      terms.length,
      p.thresholds,
    );
    attempts.push({ level: 2, strategy: 'retrieval.t1_fact', status: decision.status, score: decision.score, threshold: decision.threshold, reason: decision.reason });
    for (const f of facts.slice(0, 6)) {
      contextSources.push(docSource(f.fileId, f.documentTitle ?? 'Document', factSnippet(f), 0.7));
    }

    if (decision.status === 'SUFFICIENT_RETRIEVAL') {
      const best = Math.max(...facts.map((f) => f.matchedTerms));
      const retained = facts.filter((f) => f.matchedTerms === best && comparableOf(f) === decision.retained);
      const f = retained[0];
      const titres = [...new Set(retained.map((r) => r.documentTitle ?? 'document'))];
      const answer = isVisual(f)
        // Observation : jamais formulée comme une information écrite.
        ? `D’après l’analyse visuelle de ${joinFr(titres.map((t) => `« ${t} »`))} : ${lowerFirst(f.visualDescription ?? f.valueText ?? '')}${/[.!?]$/.test((f.visualDescription ?? f.valueText ?? '').trim()) ? '' : '.'} Cette information est observée sur l’image, elle n’est pas écrite dans le document.`
        : `${formatAttributeValue({ subject: f.subject, attribute: f.attribute, label: f.label, value: displayValue(f) })} Source : ${joinFr(titres.map((t) => `« ${t} »`))}.`;
      const sources = [...new Map(retained.map((r) => [r.fileId, docSource(r.fileId, r.documentTitle ?? 'Document', evidenceText(r))])).values()];
      return { handled: true, answer, sources, claims: [claim('fact', answer, sources, 'direct')], decision, strategy: 'retrieval.t1_fact', attempts, contextSources };
    }
    if (decision.status === 'CONFLICTING') {
      const best = Math.max(...facts.map((f) => f.matchedTerms));
      const top = facts.filter((f) => f.matchedTerms === best);
      const byValue = new Map<string, FactHit>();
      for (const f of top) if (!byValue.has(comparableOf(f))) byValue.set(comparableOf(f), f);
      const f0 = top[0];
      const what = [f0.attribute ?? f0.label ?? f0.factKey, f0.subject ? `de votre ${f0.subject.toLowerCase()}` : ''].filter(Boolean).join(' ');
      const answer = formatConflict(what, [...byValue.values()].map((f) => ({ value: displayValue(f), source: `« ${f.documentTitle ?? 'document'} »` })));
      const sources = [...byValue.values()].map((f) => docSource(f.fileId, f.documentTitle ?? 'Document', evidenceText(f)));
      // Le conflit est rendu tel quel ; une revalidation ciblée peut le lever.
      return {
        handled: true, answer, sources, claims: [claim('conflict', answer, sources, 'direct')], decision, strategy: 'retrieval.t1_fact', attempts, contextSources,
        revalidation: { trigger: 'CONFLICT', factIds: [...byValue.values()].filter((f) => revalidable(f, visuelsRevalidables)).slice(0, 3).map((f) => f.id) },
      };
    }
    if (decision.status === 'INSUFFICIENT' && decision.reason === 'LOW_CONFIDENCE' && facts.length > 0) {
      const best = Math.max(...facts.map((f) => f.matchedTerms));
      // Revalidation ciblée : faits lus (comparaison d'un extrait au texte) ;
      // observations visuelles aussi en T2 master (VISUAL_RECHECK).
      const low = facts.filter((f) => f.matchedTerms === best && revalidable(f, visuelsRevalidables)).slice(0, 2);
      if (low.length) return { ...noAnswer(decision, 'retrieval.t1_fact'), revalidation: { trigger: 'LOW_CONFIDENCE', factIds: low.map((f) => f.id) } };
    }
  }

  // ── Niveau 2 : document le plus pertinent ─────────────────────────────────
  const docs = await p.port.searchDocuments(p.accountId, terms, scopedAssetId);
  const scored = docs.map((d) => ({ ...d, score: Math.min(1, d.matchedTerms / terms.length) }));
  const decision = decideDocumentHit(scored, p.thresholds);
  attempts.push({ level: 2, strategy: 'retrieval.document', status: decision.status, score: decision.score, threshold: decision.threshold, reason: decision.reason });
  for (const d of scored.slice(0, 5)) contextSources.push(docSource(d.fileId, d.title, d.snippet ?? '', d.score));

  const best = decision.status === 'SUFFICIENT_RETRIEVAL' ? [...scored].sort((a, b) => b.score - a.score)[0] : null;
  const statut = best ? documentAnalysisStatus(best.analysisState) : null;
  const docSourceAvecStatut = (d: typeof scored[number]) => {
    const src = docSource(d.fileId, d.title, d.snippet ?? '', d.score);
    const st = documentAnalysisStatus(d.analysisState);
    return { ...src, meta: { ...src.meta, date: d.date, assetName: d.assetName, statusLabel: ANALYSIS_STATUS_LABELS[st] } };
  };

  if (best && wantsDocument) {
    const d = best;
    const details = [d.date ? formatDateFr(d.date) : null, d.assetName].filter(Boolean).join(', ');
    // §23.1 : un document en analyse peut être un résultat, avec un statut clair.
    const suite = statut === 'IN_ANALYSIS' ? ` ${IN_ANALYSIS_MESSAGE}`
      : statut === 'ANALYSIS_FAILED' ? ' Son analyse automatique n’a pas pu aboutir : vous pouvez la relancer, remplacer le fichier ou compléter les informations manuellement.'
        : '';
    const answer = `J’ai trouvé ce document : « ${d.title} »${details ? ` (${details})` : ''}.${suite}`;
    const sources = [docSourceAvecStatut(d)];
    return { handled: true, answer, sources, claims: [claim('document', answer, sources, 'direct')], decision, strategy: 'retrieval.document', attempts, contextSources };
  }

  // ══════════════════════════════════════════════════════════════════════
  // DOCUMENT TROUVÉ, VALEUR ABSENTE — TROIS ÉTATS DISTINCTS (§12.4, §23)
  //
  //   · en cours d'analyse : le texte du §23.2, sans modèle — rien n'est
  //     encore lisible, un modèle ne ferait que deviner ;
  //   · échec d'analyse : explication et orientation (§23.4), sans modèle ;
  //   · analysé, information absente : l'escalade reste possible (le modèle
  //     peut la trouver dans l'extrait) ; sinon, la réponse le dit (§19.12).
  // ══════════════════════════════════════════════════════════════════════
  if (best && (statut === 'IN_ANALYSIS' || statut === 'ANALYSIS_FAILED')) {
    const answer = statut === 'IN_ANALYSIS'
      ? `J’ai trouvé « ${best.title} ». ${IN_ANALYSIS_MESSAGE}`
      : analysisFailedMessage(best.title);
    const sources = [docSourceAvecStatut(best)];
    const d2: SufficiencyDecision = { ...decision, reason: statut === 'IN_ANALYSIS' ? 'DOCUMENT_IN_ANALYSIS' : 'DOCUMENT_ANALYSIS_FAILED' };
    attempts.push({ level: 2, strategy: 'retrieval.document_status', status: d2.status, score: d2.score, threshold: d2.threshold, reason: d2.reason });
    return {
      handled: true, answer, sources, claims: [claim('document_status', answer, sources, 'direct')], decision: d2,
      strategy: 'retrieval.document_status', attempts, contextSources,
      documentState: { kind: statut, fileId: best.fileId, title: best.title },
    };
  }

  const out = noAnswer(
    decision.status === 'SUFFICIENT_RETRIEVAL'
      // Un document pertinent n'est pas une réponse à une question de valeur.
      ? { ...decision, status: 'INSUFFICIENT', reason: 'LOW_CONFIDENCE', detail: 'document trouvé, valeur non extraite' }
      : decision,
  );
  if (best) out.documentState = { kind: 'FOUND_WITHOUT_INFO', fileId: best.fileId, title: best.title };
  return out;
}

/** Réponse sans modèle quand l'IA est indisponible et que rien n'est suffisant. */
export function fallbackFromSources(sources: RetrievedSource[]): string {
  if (sources.length === 0) {
    return 'Je n’ai pas trouvé d’élément suffisant pour répondre précisément. Pouvez-vous préciser votre demande ?';
  }
  const titres = [...new Set(sources.map((s) => s.title))].slice(0, 5).map((t) => `« ${t} »`);
  return `Je n’ai pas de réponse exacte, mais ces éléments de votre compte semblent liés à votre question : ${joinFr(titres)}.`;
}


// ── Après le retrieval classique (adaptateurs) ─────────────────────────────

/** Intentions de recherche : une liste exacte de résultats EST la réponse. */
const SEARCH_INTENTS = new Set([
  'ACCOUNT_SEARCH_ASSET', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_SUPPLIER',
  'ACCOUNT_FACT_ASSET', 'ACCOUNT_FACT_DOCUMENT', 'ACCOUNT_FACT_AGENDA', 'ACCOUNT_TO_PROCESS',
  // Informations manquantes : la liste des éléments « À traiter » en attente.
  'ACCOUNT_MISSING_INFORMATION',
]);

/**
 * Réponse « aucun résultat » (§11.4) : reformuler, filtrer, l'aide — et,
 * pour une offre sans réponses intelligentes, la mention de la fonction
 * Premium SEULEMENT si la demande appelait une interprétation.
 */
export function noResultAnswer(message: string, aiEligible = true): string {
  const base = 'Je n’ai rien trouvé de correspondant dans votre compte. '
    + 'Vous pouvez reformuler avec un autre mot (nom du bien, fournisseur, type de document), '
    + 'filtrer depuis la page Documents ou consulter l’aide.';
  return !aiEligible && requiresSynthesis(message)
    ? `${base} Les réponses qui demandent une interprétation (synthèse, comparaison) font partie de l’offre Premium.`
    : base;
}

/**
 * Aucun résultat exact, mais des résultats proches (§11.4) : ils sont
 * présentés comme tels, avec les autres pistes (reformuler, filtrer, aide).
 */
export function nearResultsAnswer(message: string, proches: RetrievedSource[], aiEligible = true): string {
  const titres = [...new Set(proches.map((s) => s.title))].slice(0, 3).map((t) => `« ${t} »`);
  const pistes = noResultAnswer(message, aiEligible).replace(/^Je n’ai rien trouvé de correspondant dans votre compte\. /, '');
  return `Je n’ai rien trouvé qui corresponde exactement. Résultats proches : ${joinFr(titres)}. ${pistes}`;
}

/**
 * `tryDeterministicFromRetrieval` — réponse exacte à partir des sources des
 * adaptateurs, avant tout appel modèle. Suffisant pour une intention de
 * recherche dont le meilleur résultat atteint le seuil `text` ; sinon, motif
 * d'escalade explicite.
 *
 * Une liste de résultats est rendue en CARTES groupées par type (§11.3,
 * §22.3), accompagnées d'une phrase de synthèse courte ; `candidates` (tous
 * les candidats classés, pas seulement les 8 sources) sert aux quotas et au
 * « Voir tous les résultats ».
 */
export function answerFromRetrievedSources(
  intent: string,
  message: string,
  sources: RetrievedSource[],
  thresholds: CascadeThresholdsLike,
  opts: { candidates?: RetrievedSource[]; aiEligible?: boolean } = {},
): { handled: boolean; answer?: string; decision: SufficiencyDecision; groups?: ResultGroup[] } {
  const threshold = thresholds.text;
  if (!SEARCH_INTENTS.has(intent) || requiresSynthesis(message)) {
    return { handled: false, decision: { status: 'INSUFFICIENT', level: 2, score: 0, threshold, reason: 'SYNTHESIS_REQUIRED', detail: `intention ${intent}` } };
  }
  if (sources.length === 0) {
    return {
      handled: true,
      answer: noResultAnswer(message, opts.aiEligible ?? true),
      decision: { status: 'SUFFICIENT_RETRIEVAL', level: 2, score: 1, threshold, detail: 'absence de résultat' },
    };
  }
  const top = Math.max(...sources.map((s) => s.relevanceScore ?? 0));
  if (threshold >= 1) {
    return { handled: false, decision: { status: 'INSUFFICIENT', level: 2, score: top, threshold, reason: 'THRESHOLD_FORCES_ESCALATION' } };
  }
  if (top < threshold) {
    return { handled: false, decision: { status: 'INSUFFICIENT', level: 2, score: top, threshold, reason: 'LOW_RELEVANCE' } };
  }
  const pool = (opts.candidates && opts.candidates.length >= sources.length ? opts.candidates : sources)
    .filter((s) => (s.relevanceScore ?? 0) >= threshold);
  const groups = buildResultGroups(pool);
  const answer = groups.length ? summarizeGroups(groups) : `J’ai trouvé : « ${pool[0]?.title ?? sources[0].title} ».`;
  // Document(s) en cours d'analyse parmi les résultats : le dire (§23.1, §23.2).
  const enAnalyse = pool.some((s) => s.meta?.analysisStatus === 'IN_ANALYSIS');
  return {
    handled: true,
    answer: enAnalyse ? `${answer} Certains documents sont encore en cours d’analyse : certaines informations peuvent ne pas être disponibles immédiatement.` : answer,
    decision: { status: 'SUFFICIENT_RETRIEVAL', level: 2, score: top, threshold },
    groups,
  };
}
