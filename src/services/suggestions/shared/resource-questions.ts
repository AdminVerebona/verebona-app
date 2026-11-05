/**
 * Catalogue des questions inspirées des RESSOURCES — lot 110E (ticket « T2 :
 * réponses issues des Ressources, couverture effective des suggestions »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT (démontré sur le corpus réel `pub108p`, test L110E-U01)
 *
 * « Quand faire la révision d’une voiture ? » (suggestion `res_car_service`,
 * article E03) était marquée « répondable » dès que E03 figurait parmi les
 * quatre premiers résultats de la recherche plein texte. Au clic, la
 * référence E03 n'était PAS transmise à T2 : la recherche repartait du
 * libellé, et deux sections obtenaient le score maximal 1,000 — la
 * présentation de C01 (« Combien coûte l’entretien d’une voiture sur un
 * an ? ») et celle de E03. À égalité, l'ordre du corpus (C avant E) plaçait
 * C01 en tête : T2 servait l'extrait « additionnez les révisions… » puis
 * « Voir aussi « Révision de voiture… » » et « Lire la Ressource ».
 *
 * DÉSORMAIS
 *
 * Chaque question de découverte déclare sa PREUVE DE RÉPONSE : article,
 * sections citables qui répondent (dans l'ordre de la réponse), sections de
 * réserves, et les SUJETS attendus avec un motif déterministe à retrouver
 * dans ces sections. La couverture est vérifiée sur le TEXTE publié (pas sur
 * la présence de l'article dans des résultats) : à la préparation de la
 * sélection (mémoïsée par version de corpus et révision d'article) et au
 * clic (revalidation serveur). Aucun appel IA.
 *
 *   VERIFIED   tous les sujets attendus sont présents dans les sections
 *              déclarées → la question peut être proposée et, au clic, ces
 *              passages sont la source prioritaire de T2 ;
 *   PARTIAL    une partie seulement des sujets est présente → la question
 *              N'EST PAS proposée ; posée quand même (question libre,
 *              ancienne sélection), la réponse dit précisément ce qui manque ;
 *   NOT_COVERED / ARTICLE_MISSING / SECTION_MISSING / CORPUS_UNAVAILABLE /
 *   EDITORIAL_REVIEW → jamais proposée, jamais imposée à T2.
 *
 * Une révision d'article différente de celle validée invalide la mémoire et
 * relance la vérification ; le diagnostic BO le signale (`revisionChanged`).
 * Aucun texte n'est rédigé ici : les motifs ne font que reconnaître ce que
 * l'article publié dit déjà.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/** Statut de couverture DÉCLARÉ (contrôle éditorial). */
export type DeclaredCoverage = 'COVERED' | 'EDITORIAL_REVIEW' | 'NOT_COVERED';

export interface ExpectedAnswerSubject {
  /** Sujet en mots simples (diagnostic BO, réponse partielle : « ne précisent pas … »). */
  subject: string;
  /** Motif à retrouver dans le texte des sections de réponse (insensible à la casse). */
  pattern: RegExp;
}

export interface ResourceQuestionEvidence {
  /** Identifiant STABLE de la question = identifiant de la suggestion (`stock.ts`). */
  questionId: string;
  /** Article principal (identifiant Ressource : `E03`). */
  articleId: string;
  /** Sections citables qui répondent, dans l'ordre de la réponse. */
  answerSections: readonly string[];
  /** Sections de précisions / réserves (facultatives). */
  reserveSections?: readonly string[];
  /** Sujets que la réponse doit contenir (vérification déterministe). */
  expect: readonly ExpectedAnswerSubject[];
  /** Révision de l'article au moment de la validation éditoriale. */
  validatedRevision: number;
  coverage: DeclaredCoverage;
}

/**
 * Catalogue — une entrée par question RESSOURCES du guide (`GUIDE_STOCK`).
 * Ajouter une question : déclarer ici l'article, les sections et les sujets
 * attendus ; le test L110E-U03 vérifie chaque entrée contre le corpus publié.
 */
export const RESOURCE_QUESTION_CATALOG: readonly ResourceQuestionEvidence[] = [
  {
    questionId: 'res_works_invoices', articleId: 'L01', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'a-la-reception-verifier-les-documents-finaux'],
    reserveSections: ['assurances-et-garanties-ne-pas-uniformiser-les-delais'],
    expect: [
      { subject: 'les devis et factures à conserver', pattern: /devis|factures?/i },
      { subject: 'les documents de réception des travaux', pattern: /procès-verbal|réception/i },
    ],
  },
  {
    questionId: 'res_boiler_service', articleId: 'E05', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'calendrier-chaudiere-les-reperes-a-distinguer'],
    reserveSections: ['comprendre-les-responsabilites'],
    expect: [{ subject: 'la fréquence de l’entretien', pattern: /entretien annuel|chaque année/i }],
  },
  {
    questionId: 'res_house_documents', articleId: 'O06', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'conserver-les-documents-de-propriete', 'garder-les-diagnostics-et-informations-recus'],
    expect: [
      { subject: 'les documents de propriété', pattern: /acte de vente|titre de propriété/i },
      { subject: 'les diagnostics reçus', pattern: /diagnostics?|DPE/i },
    ],
  },
  {
    questionId: 'res_technical_inspection', articleId: 'E01', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation'],
    reserveSections: ['tenir-compte-des-resultats-defavorables'],
    expect: [
      { subject: 'la date du premier contrôle', pattern: /quatrième anniversaire/i },
      { subject: 'la périodicité des contrôles suivants', pattern: /renouvelle|deux ans/i },
    ],
  },
  {
    questionId: 'res_car_service', articleId: 'E03', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'rechercher-le-bon-programme-constructeur'],
    reserveSections: ['quand-les-kilometres-et-le-calendrier-ne-donnent-pas-la-meme-date', 'integrer-l-usage-reel-de-la-voiture'],
    expect: [
      { subject: 'ce qui fixe la périodicité (programme du constructeur)', pattern: /programme du constructeur|programme constructeur/i },
      { subject: 'le seuil qui déclenche la révision (kilométrage ou temps)', pattern: /premier seuil atteint|intervalle en kilomètres/i },
    ],
  },
  {
    questionId: 'res_ebike_service', articleId: 'O04', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation'],
    reserveSections: ['faq-1'],
    expect: [
      { subject: 'l’entretien mécanique (freins, pneus, transmission)', pattern: /freins/i },
      { subject: 'l’entretien de la partie électrique', pattern: /batterie/i },
    ],
  },
  {
    questionId: 'res_invoice_retention', articleId: 'A03', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'reperes-de-conservation-pour-les-documents-de-biens'],
    reserveSections: ['attention-aux-dossiers-actifs'],
    expect: [{ subject: 'la durée de conservation', pattern: /cinq ans|5 ans/i }],
  },
  {
    questionId: 'res_appliance_warranty', articleId: 'G01', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'ne-pas-confondre-les-garanties'],
    reserveSections: ['anticiper-sans-se-tromper-de-promesse'],
    expect: [
      { subject: 'la date de départ de la garantie', pattern: /délivrance/i },
      { subject: 'la garantie légale de conformité', pattern: /garantie légale de conformité/i },
    ],
  },
  {
    questionId: 'res_home_inventory', articleId: 'S04', validatedRevision: 2, coverage: 'COVERED',
    answerSections: ['presentation', 'photographier-avec-une-intention-precise'],
    reserveSections: ['securiser-un-inventaire-contenant-des-donnees-personnelles'],
    expect: [
      { subject: 'les photos des objets', pattern: /photo/i },
      { subject: 'les justificatifs associés', pattern: /factures?|numéro de série/i },
    ],
  },
];

/** Empreinte du catalogue (motifs compris) : un catalogue modifié change la version des suggestions. */
export const RESOURCE_QUESTION_CATALOG_VERSION = createHash('sha256')
  .update(JSON.stringify(RESOURCE_QUESTION_CATALOG.map((e) => ({ ...e, expect: e.expect.map((x) => [x.subject, x.pattern.source]) }))))
  .digest('hex').slice(0, 12);

export const resourceQuestionEvidence = (questionId: string): ResourceQuestionEvidence | null =>
  RESOURCE_QUESTION_CATALOG.find((e) => e.questionId === questionId) ?? null;

// ── Vérification (pure) ─────────────────────────────────────────────────────

export type EvidenceStatus =
  | 'VERIFIED' | 'PARTIAL' | 'NOT_COVERED' | 'ARTICLE_MISSING' | 'SECTION_MISSING'
  | 'CORPUS_UNAVAILABLE' | 'EDITORIAL_REVIEW' | 'NO_EVIDENCE_DECLARED';

/** Vue minimale d'un article publié (corpus Ressources brut ou présenté à la recherche). */
export interface EvidenceArticleView {
  /** `E03` ou `RES-E03`. */
  id: string;
  revision?: number | null;
  sections: ReadonlyArray<{ anchor: string; heading: string; text: string }>;
}
export interface EvidenceCorpusView {
  version: string;
  environment: string;
  articles: readonly EvidenceArticleView[];
}

export interface EvidenceCheck {
  questionId: string;
  status: EvidenceStatus;
  /** Identifiant de l'article dans les sources de l'assistant (`RES-E03`). */
  articleId: string | null;
  revision: number | null;
  validatedRevision: number | null;
  revisionChanged: boolean;
  corpusVersion: string | null;
  environment: string | null;
  answerSections: string[];
  reserveSections: string[];
  /** Sections déclarées absentes de l'article publié. */
  missingSections: string[];
  /** Sujets attendus présents / absents. */
  foundSubjects: string[];
  missingSubjects: string[];
  /**
   * Phrases PROBANTES, dans l'ordre de la réponse : première phrase de la
   * première section de réponse, puis la première phrase qui porte chaque
   * sujet attendu (texte publié tel quel, sans reformulation).
   */
  answerSentences: string[];
}

const RES_PREFIX = 'RES-';
const brut = (id: string) => (id.startsWith(RES_PREFIX) ? id.slice(RES_PREFIX.length) : id);
const texte = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ');

/** Couverture d'une question sur un corpus (pure). */
export function verifyResourceEvidence(questionId: string, corpus: EvidenceCorpusView | null): EvidenceCheck {
  const e = resourceQuestionEvidence(questionId);
  const base: EvidenceCheck = {
    questionId, status: 'NO_EVIDENCE_DECLARED', articleId: e ? `${RES_PREFIX}${e.articleId}` : null, revision: null,
    validatedRevision: e?.validatedRevision ?? null, revisionChanged: false,
    corpusVersion: corpus?.version ?? null, environment: corpus?.environment ?? null,
    answerSections: [], reserveSections: [], missingSections: [], foundSubjects: [], missingSubjects: e ? e.expect.map((x) => x.subject) : [],
    answerSentences: [],
  };
  if (!e) return base;
  if (e.coverage === 'EDITORIAL_REVIEW') return { ...base, status: 'EDITORIAL_REVIEW' };
  if (e.coverage === 'NOT_COVERED') return { ...base, status: 'NOT_COVERED' };
  if (!corpus) return { ...base, status: 'CORPUS_UNAVAILABLE' };
  const a = corpus.articles.find((x) => brut(x.id) === e.articleId);
  if (!a) return { ...base, status: 'ARTICLE_MISSING' };
  const revision = typeof a.revision === 'number' ? a.revision : null;
  const revisionChanged = revision != null && revision !== e.validatedRevision;
  const par = new Map(a.sections.map((s) => [s.anchor, s]));
  const reponse = e.answerSections.filter((x) => par.has(x));
  const reserves = (e.reserveSections ?? []).filter((x) => par.has(x));
  const missingSections = [...e.answerSections, ...(e.reserveSections ?? [])].filter((x) => !par.has(x));
  const corps = reponse.map((x) => texte(`${par.get(x)!.heading} ${par.get(x)!.text}`)).join('\n');
  const foundSubjects = e.expect.filter((x) => x.pattern.test(corps)).map((x) => x.subject);
  const missingSubjects = e.expect.filter((x) => !x.pattern.test(corps)).map((x) => x.subject);
  const phrases = reponse.flatMap((x) => splitSentences(par.get(x)!.text));
  const answerSentences: string[] = [];
  const ajouter = (p: string | undefined) => { if (p && !answerSentences.includes(p)) answerSentences.push(p); };
  ajouter(splitSentences(par.get(reponse[0] ?? '')?.text ?? '')[0]);
  for (const x of e.expect) ajouter(phrases.find((p) => x.pattern.test(p)));
  const status: EvidenceStatus = reponse.length === 0
    ? 'SECTION_MISSING'
    : missingSubjects.length === 0 ? 'VERIFIED' : foundSubjects.length > 0 ? 'PARTIAL' : 'NOT_COVERED';
  return {
    ...base, status, revision, revisionChanged,
    answerSections: reponse, reserveSections: reserves, missingSections, foundSubjects, missingSubjects,
    answerSentences: answerSentences.slice(0, 4),
  };
}

/**
 * Phrases d'un texte de section (pure) : lignes de liste et de tableau
 * comprises, encadrés « À savoir — » conservés tels quels. Le point d'une
 * abréviation courante (« M. », « n° ») ne coupe pas.
 */
export function splitSentences(text: string): string[] {
  return texte(String(text ?? ''))
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý«"(])|\s+-\s+(?=[A-ZÀ-ÖØ-Ý])/)
    .map((p) => p.replace(/^[-*•]\s*/, '').trim())
    .filter((p) => p.length >= 12);
}

const memo = new Map<string, EvidenceCheck>();

/** `verifyResourceEvidence` mémoïsée par version de corpus, environnement et révision d'article. */
export function checkResourceEvidence(questionId: string, corpus: EvidenceCorpusView | null): EvidenceCheck {
  const e = resourceQuestionEvidence(questionId);
  const a = e && corpus ? corpus.articles.find((x) => brut(x.id) === e.articleId) : null;
  const key = `${RESOURCE_QUESTION_CATALOG_VERSION}:${questionId}:${corpus?.version ?? '-'}:${corpus?.environment ?? '-'}:${a ? a.revision ?? '?' : 'absent'}`;
  const known = memo.get(key);
  if (known) return known;
  const r = verifyResourceEvidence(questionId, corpus);
  if (memo.size > 2_000) memo.clear();
  memo.set(key, r);
  return r;
}

/** Réservé aux tests. */
export function resetResourceEvidenceMemo(): void { memo.clear(); }

/** Normalisation d'un libellé (comparaison d'une question libre au catalogue). */
export function normalizeQuestionLabel(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
