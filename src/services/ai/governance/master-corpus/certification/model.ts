/**
 * Lot 100B — certification du corpus de qualification IA (ticket #601,
 * arbitrage PO C2 : le corpus #601 est LA référence ; A1 : verrou de
 * promotion). Vocabulaire commun, PUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CORPUS (INV-11), ENRICHI — PAS DE SYSTÈME PARALLÈLE
 *
 * Les cas restent les fixtures natives du corpus des prompts maîtres
 * (`{ case, description, context, recording, expected, qualification.role }`,
 * répertoires `MASTER_CORPUS_DIRS`), exécutés par la qualification par couple
 * (86A) et la non-régression (99B). Ce module ajoute ce qui manquait pour
 * CERTIFIER ces cas :
 *   · un MANIFESTE versionné (une entrée par cas : identifiant immuable,
 *     opération, traitement, contrat, famille de risque, difficulté, paire,
 *     provenance, pièces, oracle, type d'évaluation, statut, motif,
 *     historique des révisions) — `manifest.ts` ;
 *   · un ORACLE structuré, approuvé individuellement depuis le BO
 *     (`oracle.ts`, `service.ts`) ;
 *   · la matrice de couverture et le VERROU A1 (`coverage.ts`).
 * Le statut RÉFÉRENCE_APPROUVÉE n'est JAMAIS écrit par un import ni par le
 * code : il est CALCULÉ (approbation humaine de l'empreinte exacte de
 * l'oracle courant, `effectiveStatus`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { AI_OPERATIONS, isMasterOperation, type AiOperationDefinition } from '../../../registry/operations';
import { TREATMENTS, treatmentOfUseCase, type Treatment } from '../../../config/treatments';

// ── Statuts (ticket #601, partie 1/5) ──────────────────────────────────────

export const CASE_STATUSES = ['REFERENCE_APPROUVEE', 'GARDE_SERVEUR', 'E2E_METIER', 'A_COMPLETER', 'HISTORIQUE', 'REJETEE'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Libellés officiels du ticket (affichage, rapports). */
export const CASE_STATUS_LABELS: Readonly<Record<CaseStatus, string>> = {
  REFERENCE_APPROUVEE: 'RÉFÉRENCE_APPROUVÉE',
  GARDE_SERVEUR: 'GARDE_SERVEUR',
  E2E_METIER: 'E2E_MÉTIER',
  A_COMPLETER: 'À_COMPLÉTER',
  HISTORIQUE: 'HISTORIQUE',
  REJETEE: 'REJETÉE',
};

/** Statuts qu'un manifeste (fichier, import) peut DÉCLARER : jamais « approuvée ». */
export const DECLARABLE_STATUSES = ['GARDE_SERVEUR', 'E2E_METIER', 'A_COMPLETER', 'HISTORIQUE', 'REJETEE'] as const satisfies readonly CaseStatus[];
export type DeclarableStatus = (typeof DECLARABLE_STATUSES)[number];

/** Lecture tolérante d'un statut écrit avec ou sans accents (`RÉFÉRENCE_APPROUVÉE`, `à compléter`…). */
export function parseCaseStatus(raw: unknown): CaseStatus | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return (CASE_STATUSES as readonly string[]).includes(s) ? (s as CaseStatus) : null;
}

// ── Classement des fixtures historiques (partie 1/5 : 27 / 20 / 11 / 7 / 21) ─

export const HISTORICAL_CLASSES = ['REPONSE_UTILISABLE', 'GARDE', 'A_CORRIGER', 'VARIANTE_CONTRAT', 'NON_REJOUABLE'] as const;
export type HistoricalClass = (typeof HISTORICAL_CLASSES)[number];
export const HISTORICAL_CLASS_LABELS: Readonly<Record<HistoricalClass, string>> = {
  REPONSE_UTILISABLE: 'réponse potentiellement utilisable',
  GARDE: 'garde serveur',
  A_CORRIGER: 'à corriger',
  VARIANTE_CONTRAT: 'variante de contrat',
  NON_REJOUABLE: 'non rejouable',
};

// ── Axes de la matrice de couverture (verrou A1) ───────────────────────────

/** Difficulté / niveau du cas. */
export const DIFFICULTIES = ['SIMPLE', 'INTERMEDIAIRE', 'DIFFICILE', 'ADVERSARIAL'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Type de test (axe « type de test » de la matrice A1). */
export const TEST_TYPES = ['QUALITE_MODELE', 'PAIRE_ADVERSARIALE', 'GARDE_SERVEUR', 'E2E_METIER', 'NON_REGRESSION'] as const;
export type TestType = (typeof TEST_TYPES)[number];

/** Type d'évaluation du cas. */
export const EVALUATION_TYPES = [
  /** Oracle structuré + contrôles serveur de la branche, sur appel RÉEL du modèle. */
  'ORACLE',
  /** Contrôle serveur de la branche seulement (garde : sortie enregistrée fautive). */
  'GARDE_SERVEUR',
  /** Scénario E2E avec données persistées (stress). */
  'E2E',
] as const;
export type EvaluationType = (typeof EVALUATION_TYPES)[number];

/**
 * Mode d'entrée du cas : `TEXT` — texte extrait fourni comme en production ;
 * `FILE` — le cas prétend tester l'OCR / le multimodal : le fichier RÉEL doit
 * être transmis au modèle (sinon NON REJOUABLE, jamais vert — partie 2/5).
 */
export const INPUT_MODES = ['TEXT', 'FILE', 'STRUCTURED'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

/**
 * Familles de risque métier par traitement — assertions du ticket (Geoffroy,
 * 27/10 19:12). Une famille absente de cette liste reste admise (`AUTRE:…`,
 * import), mais seules celles-ci sont EXIGÉES par le verrou A1.
 */
export const RISK_FAMILIES = {
  T1: ['T1_MONTANTS', 'T1_FAITS_PREUVES', 'T1_CLASSEMENT', 'T1_RATTACHEMENT', 'T1_REGROUPEMENT', 'T1_MULTIMODAL'],
  T2: ['T2_SOURCES_VERIFIEES', 'T2_CORRECTIONS_UTILISATEUR', 'T2_ABSTENTION_INJUSTIFIEE', 'T2_RECHERCHE', 'T2_INTENTION', 'T2_REVALIDATION'],
  T3: ['T3_IDENTITE_ECONOMIQUE', 'T3_DOUBLE_COMPTE', 'T3_CORRECTIONS_PRESERVEES', 'T3_RATTACHEMENT', 'T3_NOMMAGE', 'T3_CONNAISSANCE'],
  T4: ['T4_ECHEANCE', 'T4_PERIODE', 'T4_RECONDUCTION', 'T4_CLAUSE_RESILIATION', 'T4_FIN_REELLE', 'T4_PREUVE_OCCURRENCE'],
  T6: ['T6_ACTION_UTILE', 'T6_INFORMATION_UTILE', 'T6_SOLLICITATION_INUTILE'],
} as const satisfies Record<Treatment, readonly string[]>;

export const RISK_FAMILY_LABELS: Readonly<Record<string, string>> = {
  T1_MONTANTS: 'tous les montants extraits', T1_FAITS_PREUVES: 'faits avec leurs preuves', T1_CLASSEMENT: 'type de document',
  T1_RATTACHEMENT: 'bien / équipement rattaché', T1_REGROUPEMENT: 'regroupement des fichiers', T1_MULTIMODAL: 'lecture du fichier réel (OCR, visuel)',
  T2_SOURCES_VERIFIEES: 'réponse depuis les sources vérifiées', T2_CORRECTIONS_UTILISATEUR: 'corrections de l’utilisateur respectées',
  T2_ABSTENTION_INJUSTIFIEE: 'pas d’abstention si une réponse fiable existe', T2_RECHERCHE: 'recherche de l’assistant (CDC 4 §35)',
  T2_INTENTION: 'compréhension de la question', T2_REVALIDATION: 'revalidation sur la source',
  T3_IDENTITE_ECONOMIQUE: 'identité économique des événements', T3_DOUBLE_COMPTE: 'aucun double compte', T3_CORRECTIONS_PRESERVEES: 'corrections utilisateur préservées',
  T3_RATTACHEMENT: 'rattachement document ↔ bien', T3_NOMMAGE: 'nommage des documents', T3_CONNAISSANCE: 'connaissances consolidées',
  T4_ECHEANCE: 'échéance', T4_PERIODE: 'période', T4_RECONDUCTION: 'reconduction', T4_CLAUSE_RESILIATION: 'clause de résiliation',
  T4_FIN_REELLE: 'fin réelle du contrat', T4_PREUVE_OCCURRENCE: 'preuve rattachée à la bonne occurrence',
  T6_ACTION_UTILE: 'action utile', T6_INFORMATION_UTILE: 'information utile', T6_SOLLICITATION_INUTILE: 'sollicitation inutile (à supprimer)',
};

export function riskFamiliesOf(t: Treatment): readonly string[] {
  return RISK_FAMILIES[t];
}

// ── Opérations actives (recalculées depuis le registre, jamais T5) ─────────

export interface ActiveOperation { operationCode: string; treatment: Treatment; task: string; label: string }

/**
 * Opérations IA ACTIVES à couvrir : opérations MASTER actives du registre
 * applicatif, rattachées à un traitement T1–T6 (jamais T5, retiré ; jamais
 * l'usage technique AI_GOVERNANCE). Une nouvelle opération entre ici dès
 * qu'elle est active : elle doit être couverte avant toute promotion (A1).
 */
export function activeQualificationOperations(
  ops: Readonly<Record<string, AiOperationDefinition | undefined>> = AI_OPERATIONS,
): ActiveOperation[] {
  const out: ActiveOperation[] = [];
  for (const op of Object.values(ops)) {
    if (!op || !op.active || op.provider === 'none' || !isMasterOperation(op)) continue;
    const t = treatmentOfUseCase(op.useCaseCode);
    if (!t || !(TREATMENTS as readonly string[]).includes(t)) continue;
    out.push({ operationCode: op.operationCode, treatment: t, task: op.task, label: op.label });
  }
  return out.sort((a, b) => a.treatment.localeCompare(b.treatment) || a.operationCode.localeCompare(b.operationCode));
}

// ── Oracle (partie 1/5 : contenu d'un oracle) ──────────────────────────────

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Preuve / provenance d'un fait : pièce source et extrait. Jamais la sortie d'un modèle. */
export const oracleEvidence = z.object({
  /** Pièce source (fichier du ZIP, identifiant de source du contexte, « context.extractedContent »…). */
  source: z.string().min(1).max(300),
  /** Extrait recopié de la source, s'il y en a un. */
  excerpt: z.string().max(2000).nullable().optional(),
  page: z.number().int().positive().nullable().optional(),
});
export type OracleEvidence = z.infer<typeof oracleEvidence>;

export const FACT_KINDS = ['AMOUNT', 'DATE', 'TEXT', 'IDENTIFIER', 'STATUS', 'ENTITY', 'NUMBER', 'BOOLEAN'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const oracleFact = z.object({
  /** Clé stable du fait dans l'oracle (ex. `montant_ttc`, `echeance_2027`). */
  key: z.string().min(1).max(120),
  kind: z.enum(FACT_KINDS),
  /** Valeur attendue : montant en unité `unit` (EUR par défaut), date AAAA-MM-JJ, texte… */
  value: scalar,
  unit: z.string().max(20).nullable().optional(),
  /** Fait crucial : son omission ou son erreur est une erreur CRITIQUE (A1, mutations). */
  critical: z.boolean().default(true),
  /** Le fait doit être porté AVEC sa preuve dans la sortie (T1 : extrait). */
  evidenceRequired: z.boolean().default(false),
  /** Entité (bien, équipement, contrat) à laquelle le fait se rattache, si pertinent. */
  entity: z.string().max(120).nullable().optional(),
  evidence: z.array(oracleEvidence).max(10).default([]),
});
export type OracleFact = z.infer<typeof oracleFact>;

export const oracleSchema = z.object({
  version: z.number().int().positive(),
  /** Faits OBLIGATOIRES (une omission fait échouer, même avec un JSON valide). */
  requiredFacts: z.array(oracleFact).max(200).default([]),
  /** Faits ABSENTS : valeurs qui ne doivent JAMAIS apparaître (invention, valeur d'un autre bien, total additionné…). */
  absentFacts: z.array(z.object({ key: z.string().min(1).max(120), kind: z.enum(FACT_KINDS), value: scalar, unit: z.string().max(20).nullable().optional(), reason: z.string().max(400).optional() })).max(100).default([]),
  /** Résolution d'entités : identifiants attendus et interdits (bien, équipement, Opération, candidat…). */
  entities: z.object({
    expected: z.array(z.union([z.string(), z.number()])).max(50).default([]),
    forbidden: z.array(z.union([z.string(), z.number()])).max(50).default([]),
  }).default({ expected: [], forbidden: [] }),
  /** Décisions permises / interdites (action, issue, statut, catégorie…). Vide : non contraint. */
  decisions: z.object({
    allowed: z.array(z.string().max(80)).max(30).default([]),
    forbidden: z.array(z.string().max(80)).max(30).default([]),
  }).default({ allowed: [], forbidden: [] }),
  /** Critères d'abstention : `ANSWER` (réponse fiable : s'abstenir est une erreur), `ABSTAIN`, `EITHER`. */
  abstention: z.object({
    expected: z.enum(['ANSWER', 'ABSTAIN', 'EITHER']).default('EITHER'),
    criteria: z.string().max(1000).nullable().optional(),
  }).default({ expected: 'EITHER' }),
  /** Sources autorisées (identifiants du contexte) : toute autre source citée est INVENTÉE. Vide : non contrôlé. */
  allowedSources: z.array(z.string().max(300)).max(100).default([]),
  /** Équivalences sémantiques tolérées : valeurs admises pour un fait (synonymes, formats). */
  equivalences: z.array(z.object({ key: z.string().min(1).max(120), values: z.array(scalar).min(1).max(30) })).max(100).default([]),
  /** Tolérance numérique absolue par défaut des montants (EUR) — 0 : exact au centime. */
  amountTolerance: z.number().min(0).max(1).default(0),
  /** Attendus des contrôles serveur existants (`evaluators.ts`), repris tels quels. */
  serverExpected: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Note libre du rédacteur (sources consultées, raisonnement). */
  notes: z.string().max(4000).nullable().optional(),
});
export type Oracle = z.infer<typeof oracleSchema>;

// ── Entrée de manifeste ────────────────────────────────────────────────────

export const PROVENANCES = ['HISTORIQUE_86', 'AJOUT_LOTS_97_99', 'REFERENCE_T1', 'ZIP_601', 'STRESS_601', 'DEVELOPPEUR'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const manifestRevision = z.object({
  revision: z.number().int().positive(),
  at: z.string().min(10).max(40),
  by: z.string().min(1).max(120),
  /** Motif de la révision (import, correction d'identifiant, oracle modifié…). */
  reason: z.string().min(1).max(1000),
  /** Champs modifiés. */
  changes: z.array(z.string().max(80)).max(40).default([]),
  /** Empreinte de l'oracle après la révision (null : sans oracle). */
  oracleFingerprint: z.string().max(80).nullable().optional(),
});
export type ManifestRevision = z.infer<typeof manifestRevision>;

export const manifestEntry = z.object({
  /** Identifiant IMMUABLE (jamais réattribué, jamais supprimé). */
  id: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{1,79}$/),
  /** Identifiant d'origine (champ `case` de la fixture, ligne du ZIP). */
  sourceCaseId: z.string().max(120).nullable(),
  /** Fichier de cas exécutable (relatif à la racine du dépôt), null : spécification non convertie. */
  file: z.string().max(400).nullable(),
  operationCode: z.string().max(80).nullable(),
  treatment: z.enum(['T1', 'T2', 'T3', 'T4', 'T6']).nullable(),
  /** Contrat de sortie (ex. `t4_output_v3`) et schéma de la branche. */
  contract: z.string().max(80).nullable(),
  schema: z.string().max(80).nullable(),
  riskFamily: z.string().max(80).nullable(),
  difficulty: z.enum(DIFFICULTIES).nullable(),
  /** Cas critique : oracle approuvé ET résultat concluant exigés avant promotion (A1). */
  critical: z.boolean(),
  pair: z.object({
    id: z.string().max(80),
    side: z.enum(['A', 'B']),
    /** Le discriminant DOIT changer la décision (true) ou NE DOIT PAS (simple variation de présentation). */
    discriminantChangesDecision: z.boolean(),
    discriminant: z.string().max(400).nullable().optional(),
  }).nullable(),
  provenance: z.enum(PROVENANCES),
  /** Pièces sources (fichiers du ZIP, pièces jointes) : chemins relatifs au dépôt. */
  sourcePieces: z.array(z.object({ path: z.string().max(400), mimeType: z.string().max(100), sha256: z.string().max(80).nullable().optional() })).max(20),
  inputMode: z.enum(INPUT_MODES),
  testType: z.enum(TEST_TYPES),
  evaluationType: z.enum(EVALUATION_TYPES),
  /** Statut DÉCLARÉ (jamais RÉFÉRENCE_APPROUVÉE : calculé depuis l'approbation). */
  status: z.enum(DECLARABLE_STATUSES),
  reason: z.string().min(1).max(1000),
  historicalClass: z.enum(HISTORICAL_CLASSES).nullable(),
  /** Catégorie CDC 4 §35.1 (cas T2 de recherche de l'assistant). */
  cdc35Category: z.string().max(40).nullable().optional(),
  oracle: oracleSchema.nullable(),
  /** Résumé de l'attendu (lecture humaine). */
  expectedSummary: z.string().max(2000).nullable(),
  revisions: z.array(manifestRevision).min(1),
});
export type ManifestEntry = z.infer<typeof manifestEntry>;

export const corpusManifest = z.object({
  /** Version du manifeste : incrémentée à chaque révision publiée. */
  version: z.number().int().positive(),
  generatedAt: z.string().min(10),
  /** Référence du corpus (#601) et compteurs annoncés (jamais « tests validés »). */
  reference: z.object({ ticket: z.string(), announcedScenarios: z.number().int(), announcedStress: z.number().int(), zipReceived: z.boolean() }),
  entries: z.array(manifestEntry),
  /** Registre des identifiants déjà publiés : un identifiant ne disparaît jamais (aucune suppression silencieuse). */
  ledger: z.array(z.string()),
});
export type CorpusManifest = z.infer<typeof corpusManifest>;
