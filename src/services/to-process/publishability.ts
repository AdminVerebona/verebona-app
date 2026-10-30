/**
 * Lot 98B (ticket P0 « À traiter — ne publier une carte que si son utilité
 * est démontrée », P0-E) — « carte OUVERTE » ≠ « carte PUBLIABLE ».
 * Lot 100E (décision PO A7 du 27/10/2026) — règle GÉNÉRALISÉE à TOUTES les
 * familles de cartes, par un contrat commun.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES DEUX CONDITIONS CUMULATIVES DU PO (A7)
 *
 *   1. une intervention de l'utilisateur présente un intérêt réel et
 *      suffisamment important ;
 *   2. Verebona ne dispose pas déjà d'une réponse suffisamment fiable grâce
 *      aux données, preuves ou calculs disponibles.
 *
 * Elles sont réévaluées à la CRÉATION et à la CONSERVATION (`upsertAction` :
 * `cardPremiseStillHolds`), par les CONTRÔLES DE COHÉRENCE (COH-TODO-*,
 * dont COH-TODO-PUBLISHABILITY qui nettoie le stock) et JUSTE AVANT
 * L'AFFICHAGE (`publishableCardSql`, lu par la page, le compteur, la
 * pastille, l'accueil, la mascotte, les notifications et l'assistant).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉFINITION UNIQUE — une carte OUVERTE (`resolved_at IS NULL`) est, dans cet
 * ordre :
 *
 *   · TARGET_GONE        son objet n'existe plus (document supprimé ou
 *                        regroupé, bien supprimé, élément d'agenda,
 *                        équipement ou pièce disparus) — fermée par
 *                        COH-TODO-ORPHAN-CARDS et le balayage horaire
 *                        (affichage inchangé d'ici là : libellé « introuvable ») ;
 *   · NO_LONGER_USEFUL   la prémisse déclarée par le contrat de SA règle ne
 *                        tient plus : la réponse est déjà connue (date
 *                        saisie ailleurs, équipement rattaché, statut posé
 *                        par l'utilisateur…) ou l'intérêt a disparu
 *                        (équipement archivé, revue fournisseur close,
 *                        événement de référence fusionné…) — fermée par le
 *                        service de la famille (contrôle déclaré par le
 *                        contrat) ;
 *   · RETENUE (HELD)     Verebona n'a pas pu statuer : blocage TECHNIQUE —
 *                        relève de la SUPERVISION, jamais de « À traiter » :
 *       - carte documentaire : dernière décision tracée
 *         (`document_rule_evaluations`, même document, même règle) au motif
 *         KEPT_T4_INCOMPATIBLE, KEPT_INTERPRETATION_PENDING,
 *         KEPT_INTERPRETATION_INCOMPLETE, KEPT_ON_TECHNICAL_FAILURE, ou issue
 *         ERROR (lot 98B) ;
 *       - autres familles (lot 100E) : dernière décision tracée de la famille
 *         (`to_process_decisions`, même cible, même règle) en erreur
 *         (issue ou effet ERROR), ou différée en gardant la carte
 *         (DEFER + KEPT : qualification en attente, utilité non établie) ;
 *       - règle SANS contrat déclaré (famille future oubliée) : retenue,
 *         jamais montrée en silence (cause RULE_NOT_DECLARED, Supervision ;
 *         le test L100E-U-CONTRACT échoue avant tout déploiement) — un code
 *         HORS catalogue (carte héritée, jeu d'essai) garde le contrat commun ;
 *   · PUBLISHABLE        sinon.
 *
 * Une carte retenue reste OUVERTE (jamais fermée sur une panne) ; une carte
 * devenue inutile est fermée par la chaîne de sa famille, tracée, sans jamais
 * écrire de donnée à la place de l'utilisateur (ses modifications manuelles
 * font foi : c'est souvent elles qui rendent la carte inutile).
 *
 * Lecture SQL seule — aucun appel T3 / T4 au chargement d'une page. Aucun
 * état persistant supplémentaire : décisions tracées et état des objets SONT
 * l'état ; le stock est donc rattrapé de lui-même à l'affichage, puis fermé
 * par la campagne de cohérence (aucune migration, aucune commande).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { PROCESSING_RULES } from './rules-catalog';

// ══════════════════════════════════════════════════════════════════════════
// CONTRAT COMMUN DES FAMILLES (lot 100E, A7)
// ══════════════════════════════════════════════════════════════════════════

/** Familles de cartes (libellés simples, jamais « Opération »). */
export type CardFamily = 'DOCUMENTS' | 'AGENDA' | 'EQUIPEMENTS' | 'FOURNISSEURS' | 'EVENEMENTS_DE_REFERENCE' | 'BIENS';

export const CARD_FAMILY_LABELS: Readonly<Record<CardFamily, string>> = {
  DOCUMENTS: 'documents',
  AGENDA: 'agenda',
  EQUIPEMENTS: 'équipements',
  FOURNISSEURS: 'fournisseurs',
  EVENEMENTS_DE_REFERENCE: 'événements de référence',
  BIENS: 'biens et pièces',
};

/** Service de nettoyage d'une carte devenue inutile (appelé par COH-TODO-PUBLISHABILITY). */
export type CleanupService =
  | 'produceAgendaActions'
  | 'produceEquipmentActions'
  | 'produceSupplierActions'
  | 'closeAgendaStatusCards'
  | 'closeCardsNoLongerUseful';

/** Identifiant du contrôle de nettoyage rétroactif (registre de cohérence). */
export const PUBLISHABILITY_CHECK_ID = 'COH-TODO-PUBLISHABILITY';

export interface PublishabilityContract {
  family: CardFamily;
  /**
   * Où vit la DERNIÈRE décision du moteur de la famille (source des blocages
   * techniques) : décision documentaire (0418), décision de famille « état »
   * (0516), ou production seule (la carte n'existe que si le producteur a
   * démontré une ambiguïté réelle ; sa pertinence est rejugée par le contrôle
   * de la famille).
   */
  decisions: 'DOCUMENT_RULE' | 'FAMILY_DECISION' | 'PRODUCTION';
  /**
   * Conditions 1 et 2 réévaluées sur l'ÉTAT COURANT (SQL, `a` = alias de
   * `to_process_actions`) : VRAI quand la carte n'est plus utile (réponse
   * déjà connue, intérêt disparu). `null` : la prémisse est jugée par le
   * moteur de la famille (décision tracée, contrôle dédié).
   */
  noLongerUseful: ((a: string) => string) | null;
  /** Motif tracé de la fermeture (code stable). */
  reason?: string;
  /**
   * Qui ferme la carte devenue inutile : ce contrôle (avec le service de la
   * famille), le contrôle du registre qui en est déjà seul chargé (C-Q9 :
   * une anomalie, une chaîne), ou le balayage horaire (`SWEEP:<service>`).
   */
  cleanup: { by: typeof PUBLISHABILITY_CHECK_ID; service: CleanupService } | { by: string };
  /** La prémisse est aussi vérifiée à la création / conservation (`upsertAction`). */
  atCreation?: boolean;
}

/** Élément d'agenda du compte (alias `a`) répondant à `cond` (alias `i`). */
const agendaItem = (a: string, cond: string) =>
  `EXISTS (SELECT 1 FROM agenda_items i WHERE i.id = ${a}.target_id AND i.account_id = ${a}.account_id AND (${cond}))`;

/** Identifiant numérique sûr lu dans le contexte de la carte (jamais une erreur de conversion). */
const idDe = (expr: string) => `CASE WHEN (${expr}) ~ '^[0-9]{1,18}$' THEN (${expr})::bigint END`;

/** Événement de référence fusionné ou invalidé (id de la réalité : expression SQL). */
const evenementRetire = (a: string, idExpr: string) =>
  `EXISTS (SELECT 1 FROM business_operations o WHERE o.account_id = ${a}.account_id AND o.id = ${idDe(idExpr)}
             AND (o.merged_into_operation_id IS NOT NULL OR o.invalidated_at IS NOT NULL))`;

const parProduction = (family: CardFamily, by: string): PublishabilityContract => ({ family, decisions: 'PRODUCTION', noLongerUseful: null, cleanup: { by } });

/**
 * Contrat de CHAQUE règle du catalogue (`rules-catalog.ts`). Une règle
 * ajoutée sans contrat fait échouer L100E-U-CONTRACT ; en production, ses
 * cartes seraient retenues (RULE_NOT_DECLARED), jamais montrées en silence.
 */
export const PUBLISHABILITY_CONTRACTS: Readonly<Record<string, PublishabilityContract>> = {
  // ── Documents ──────────────────────────────────────────────────────────
  // Classement : moteur de décision (`applyV2Classification`) et COH-DOC-CLASSIFICATION.
  'DOC-RUB': parProduction('DOCUMENTS', 'COH-DOC-CLASSIFICATION'),
  'DOC-TYP': parProduction('DOCUMENTS', 'COH-DOC-CLASSIFICATION'),
  'LINK-ASSET': {
    family: 'DOCUMENTS', decisions: 'DOCUMENT_RULE', reason: 'DOCUMENT_ALREADY_ATTACHED', atCreation: true,
    // Cardinalité « au moins un » : un document déjà rattaché à un bien vivant n'appelle plus de question.
    // Un bien seulement CITÉ (lien MENTIONED posé par l'analyse) n'est pas un rattachement : la question reste utile.
    noLongerUseful: (a) => `(EXISTS (SELECT 1 FROM asset_files f JOIN assets s ON s.id = f.asset_id AND s.account_id = f.account_id AND s.deleted_at IS NULL
                                     WHERE f.id = ${a}.target_id AND f.account_id = ${a}.account_id)
                          OR EXISTS (SELECT 1 FROM document_asset_links l JOIN assets s ON s.id = l.asset_id AND s.deleted_at IS NULL
                                      WHERE l.file_id = ${a}.target_id AND s.account_id = ${a}.account_id AND l.status = 'ACTIVE'
                                        AND l.link_role IN ('PRIMARY', 'SECONDARY')
                                        AND l.equipment_id IS NULL AND l.substructure_id IS NULL))`,
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'closeCardsNoLongerUseful' },
  },
  // Conflit de rattachement : clos par le balayage horaire (`closeObsoleteAssetConflicts`).
  'LINK-ASSET-CONFLICT': parProduction('DOCUMENTS', 'SWEEP:closeObsoleteAssetConflicts'),
  // Lien document → équipement proposé par T3 : un document peut concerner PLUSIEURS équipements — un premier
  // rattachement ne tranche pas l'ambiguïté restante ; jugé par la production (T3), cible disparue : orphelins.
  'LINK-ELT': parProduction('DOCUMENTS', 'COH-TODO-ORPHAN-CARDS'),
  'DATA-CONTRACT-END': { family: 'DOCUMENTS', decisions: 'DOCUMENT_RULE', noLongerUseful: null, cleanup: { by: 'COH-TODO-DOCUMENT-FIELDS' } },
  'DATA-WARRANTY-END': { family: 'DOCUMENTS', decisions: 'DOCUMENT_RULE', noLongerUseful: null, cleanup: { by: 'COH-TODO-DOCUMENT-FIELDS' } },
  'DATA-SUPPLIER': { family: 'DOCUMENTS', decisions: 'DOCUMENT_RULE', noLongerUseful: null, cleanup: { by: 'COH-TODO-DOCUMENT-FIELDS' } },
  'DOC-INTERVENTION': parProduction('DOCUMENTS', 'COH-TODO-RELEVANCE-CARDS'),

  // ── Agenda ─────────────────────────────────────────────────────────────
  'DATA-AGENDA-DATE': {
    family: 'AGENDA', decisions: 'FAMILY_DECISION', reason: 'DATE_KNOWN_OR_EVENT_SETTLED', atCreation: true,
    // Date saisie ailleurs, élément réalisé / annulé, ou « Sans échéance » choisi par l'utilisateur.
    noLongerUseful: (a) => agendaItem(a, `i.start_date IS NOT NULL OR NULLIF(i.manual_status, '') IS NOT NULL OR i.no_deadline = true`),
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'produceAgendaActions' },
  },
  'AGENDA-DUPLICATE': parProduction('AGENDA', 'COH-TODO-ORPHAN-CARDS'),
  'AGENDA-DONE': {
    family: 'AGENDA', decisions: 'PRODUCTION', reason: 'STATUS_SET_BY_USER', atCreation: true,
    noLongerUseful: (a) => agendaItem(a, `NULLIF(i.manual_status, '') IS NOT NULL`),
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'closeAgendaStatusCards' },
  },
  'AGENDA-NOT-DONE': {
    family: 'AGENDA', decisions: 'PRODUCTION', reason: 'STATUS_SET_BY_USER', atCreation: true,
    noLongerUseful: (a) => agendaItem(a, `NULLIF(i.manual_status, '') IS NOT NULL`),
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'closeAgendaStatusCards' },
  },
  'AGENDA-PROPOSAL': {
    family: 'AGENDA', decisions: 'PRODUCTION', reason: 'ALREADY_SCHEDULED',
    noLongerUseful: (a) => `EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = ${a}.account_id
                                      AND i.functional_key = ${a}.trigger_context->>'functionalKey')`,
    cleanup: { by: 'COH-TODO-AGENDA-PROPOSAL-CARDS' },
  },
  'AGENDA-PROJECTION-MATCH': {
    family: 'AGENDA', decisions: 'PRODUCTION', reason: 'REFERENCE_EVENT_WITHDRAWN',
    noLongerUseful: (a) => evenementRetire(a, `split_part(${a}.relation_key, ':', 2)`),
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'closeCardsNoLongerUseful' },
  },

  // ── Biens et pièces ────────────────────────────────────────────────────
  'DATA-REGISTRATION': parProduction('BIENS', 'COH-TODO-T3-FIELD-CARDS'),
  'DATA-ACQUISITION-PRICE': parProduction('BIENS', 'COH-TODO-T3-FIELD-CARDS'),
  'DATA-ACQUISITION-DATE': parProduction('BIENS', 'COH-TODO-T3-FIELD-CARDS'),
  'MIG-REVIEW': parProduction('BIENS', 'COH-TODO-MIGRATION-REVIEW-CARDS'),
  'ENTITY-FIELD-ROOM': parProduction('BIENS', 'COH-TODO-T3-FIELD-CARDS'),
  'ASSET-STATUS': {
    family: 'BIENS', decisions: 'PRODUCTION', reason: 'STATUS_CHANGED_SINCE', atCreation: true,
    // Statut du bien changé depuis la proposition (par l'utilisateur, ou déjà appliqué) : rien à demander.
    noLongerUseful: (a) => `EXISTS (SELECT 1 FROM assets s
                                    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${a}.proposals_json) = 'array' THEN ${a}.proposals_json ELSE '[]'::jsonb END) p
                                    WHERE s.id = ${a}.target_id AND s.account_id = ${a}.account_id AND s.deleted_at IS NULL
                                      AND p->>'isCurrentValue' = 'true' AND s.status IS DISTINCT FROM p->>'value')`,
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'closeCardsNoLongerUseful' },
  },

  // ── Équipements ────────────────────────────────────────────────────────
  'LINK-EQUIP-ASSET': {
    family: 'EQUIPEMENTS', decisions: 'FAMILY_DECISION', reason: 'EQUIPMENT_ATTACHED_OR_INACTIVE', atCreation: true,
    noLongerUseful: (a) => `EXISTS (SELECT 1 FROM equipments e LEFT JOIN assets s ON s.id = e.asset_id
                                    WHERE e.id = ${a}.target_id
                                      AND ((s.id IS NOT NULL AND s.deleted_at IS NULL) OR e.archived_at IS NOT NULL
                                           OR e.status IN ('ARCHIVED', 'TRANSMIS', 'HORS_SERVICE')))`,
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'produceEquipmentActions' },
  },
  'ENTITY-FIELD': parProduction('EQUIPEMENTS', 'COH-TODO-T3-FIELD-CARDS'),

  // ── Fournisseurs ───────────────────────────────────────────────────────
  'SUPPLIER-IDENTITY': {
    family: 'FOURNISSEURS', decisions: 'FAMILY_DECISION', reason: 'SUPPLIER_REVIEW_CLOSED', atCreation: true,
    noLongerUseful: (a) => `NOT EXISTS (SELECT 1 FROM supplier_review_items r WHERE r.account_id = ${a}.account_id AND r.status = 'open'
                                         AND COALESCE(r.supplier_id, r.id) = ${a}.target_id)`,
    cleanup: { by: PUBLISHABILITY_CHECK_ID, service: 'produceSupplierActions' },
  },

  // ── Événements de référence (consolidation T3) ─────────────────────────
  'OPERATION-MATCH': {
    family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', reason: 'MATCH_CANDIDATE_GONE',
    noLongerUseful: (a) => `NOT EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.account_id = ${a}.account_id AND c.file_id = ${a}.target_id
                                         AND c.candidate_key = ${a}.trigger_context->>'candidateKey' AND c.status = 'ACTIVE')`,
    cleanup: { by: 'COH-TODO-OPERATION-CARDS' },
  },
  'OPERATION-AMOUNT': {
    family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', reason: 'REFERENCE_EVENT_WITHDRAWN',
    noLongerUseful: (a) => evenementRetire(a, `${a}.trigger_context->>'operationId'`), cleanup: { by: 'COH-TODO-OPERATION-CARDS' },
  },
  'OPERATION-CURRENCY': {
    family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', reason: 'REFERENCE_EVENT_WITHDRAWN',
    noLongerUseful: (a) => evenementRetire(a, `${a}.trigger_context->>'operationId'`), cleanup: { by: 'COH-TODO-OPERATION-CARDS' },
  },
  'OPERATION-CLAIM-ASSET': {
    family: 'EVENEMENTS_DE_REFERENCE', decisions: 'PRODUCTION', reason: 'REFERENCE_EVENT_WITHDRAWN',
    noLongerUseful: (a) => evenementRetire(a, `${a}.trigger_context->>'operationId'`), cleanup: { by: 'COH-TODO-OPERATION-CARDS' },
  },
};

/** Règles déclarées (codes du contrat commun). */
export const DECLARED_RULES: readonly string[] = Object.keys(PUBLISHABILITY_CONTRACTS);

/**
 * Règles DU CATALOGUE sans contrat (famille future oubliée) — retenues à
 * l'affichage. Un code hors catalogue (carte héritée, jeu d'essai) n'est
 * jamais produit par `upsertAction` (règle inconnue refusée) : il garde le
 * contrat commun par défaut (blocages techniques tracés, cible vivante).
 */
export function undeclaredCatalogRules(catalog: ReadonlyArray<{ code: string }> = PROCESSING_RULES): string[] {
  return undeclaredRules(catalog);
}

/** Contrat d'une règle (`undefined` : famille non déclarée). */
export const contractOf = (ruleCode: string): PublishabilityContract | undefined => PUBLISHABILITY_CONTRACTS[ruleCode];

/** Famille d'une règle (`null` : non déclarée). */
export const familyOf = (ruleCode: string): CardFamily | null => contractOf(ruleCode)?.family ?? null;

/**
 * Règles d'un catalogue SANS contrat déclaré (pure) — L100E-U-CONTRACT : une
 * famille future sans règle déclarée est SIGNALÉE, jamais affichée en silence.
 */
export function undeclaredRules(rules: ReadonlyArray<{ code: string }>): string[] {
  return rules.map((r) => r.code).filter((c) => !PUBLISHABILITY_CONTRACTS[c]);
}

// ══════════════════════════════════════════════════════════════════════════
// BLOCAGES TECHNIQUES (Supervision)
// ══════════════════════════════════════════════════════════════════════════

/** Motifs de maintien TECHNIQUE (décision documentaire) → cause affichée en Supervision. */
export const TECHNICAL_HOLD_REASONS = {
  KEPT_T4_INCOMPATIBLE: 'T4_INCOMPATIBLE',
  KEPT_INTERPRETATION_PENDING: 'INTERPRETATION_PENDING',
  KEPT_INTERPRETATION_INCOMPLETE: 'INTERPRETATION_INCOMPLETE',
  KEPT_ON_TECHNICAL_FAILURE: 'AI_UNAVAILABLE',
} as const;

export type TechnicalHoldCause =
  | (typeof TECHNICAL_HOLD_REASONS)[keyof typeof TECHNICAL_HOLD_REASONS]
  | 'EVALUATION_ERROR'
  /** Lot 100E : décision de famille différée en gardant la carte (qualification en attente). */
  | 'DECISION_DEFERRED'
  /** Lot 100E : règle sans contrat de publication déclaré. */
  | 'RULE_NOT_DECLARED';

/** Libellés simples des causes (Supervision, BO). */
export const HOLD_CAUSE_LABELS: Readonly<Record<TechnicalHoldCause, string>> = {
  T4_INCOMPATIBLE: 'configuration T4 active incompatible (contrat t4_output_v3 attendu)',
  INTERPRETATION_PENDING: 'interprétation T3 de la connaissance en attente (capacité, budget ou nouvelle tentative)',
  INTERPRETATION_INCOMPLETE: 'interprétation T3 incomplète (connaissance au-delà des bornes)',
  AI_UNAVAILABLE: 'IA ou configuration indisponible (panne, délai dépassé)',
  EVALUATION_ERROR: 'évaluation de la règle en erreur',
  DECISION_DEFERRED: 'décision différée : qualification en attente, utilité de la question non encore établie',
  RULE_NOT_DECLARED: 'famille de cartes sans règle de publication déclarée (contrat commun à compléter)',
};

export type CardStanding =
  /** Aucune décision documentaire tracée (autres familles, cartes antérieures au diagnostic) : publiable. */
  | { kind: 'NO_DECISION' }
  /** La dernière décision maintient ou crée la carte pour une raison démontrée (donnée utile, intervention, arbitrage…). */
  | { kind: 'JUSTIFIED'; reasonCode: string | null; ambiguity: boolean }
  /** Maintien par incapacité technique de statuer : supervision, jamais « À traiter ». */
  | { kind: 'TECHNICAL_HOLD'; reasonCode: string | null; cause: TechnicalHoldCause };

/**
 * Statut de publication d'une carte DOCUMENTAIRE d'après la DERNIÈRE décision
 * de son moteur (pure) — même règle que `heldCardSql`.
 */
export function cardStanding(last: { outcome: string | null; reasonCode: string | null } | null): CardStanding {
  if (!last) return { kind: 'NO_DECISION' };
  if (last.outcome === 'ERROR') return { kind: 'TECHNICAL_HOLD', reasonCode: last.reasonCode, cause: 'EVALUATION_ERROR' };
  const cause = last.reasonCode ? (TECHNICAL_HOLD_REASONS as Record<string, TechnicalHoldCause>)[last.reasonCode] : undefined;
  if (cause) return { kind: 'TECHNICAL_HOLD', reasonCode: last.reasonCode, cause };
  return { kind: 'JUSTIFIED', reasonCode: last.reasonCode, ambiguity: last.reasonCode === 'AMBIGUOUS' };
}

/**
 * Lot 100E — même règle pour la dernière décision d'une famille « état »
 * (`to_process_decisions`, pure) : erreur (issue ou effet) ; décision
 * différée qui GARDE une carte (DEFER + KEPT : utilité non établie). Les
 * autres décisions (création, maintien justifié) laissent la carte publiable.
 */
export function familyCardStanding(last: { outcome: string | null; effect: string | null; reasonCode?: string | null } | null): CardStanding {
  if (!last) return { kind: 'NO_DECISION' };
  if (last.outcome === 'ERROR' || last.effect === 'ERROR') return { kind: 'TECHNICAL_HOLD', reasonCode: last.reasonCode ?? null, cause: 'EVALUATION_ERROR' };
  if (last.outcome === 'DEFER' && last.effect === 'KEPT') return { kind: 'TECHNICAL_HOLD', reasonCode: last.reasonCode ?? null, cause: 'DECISION_DEFERRED' };
  return { kind: 'JUSTIFIED', reasonCode: last.reasonCode ?? null, ambiguity: false };
}

export const isPublishable = (s: CardStanding): boolean => s.kind !== 'TECHNICAL_HOLD';

/** Sous-requête : dernière décision documentaire de la carte `a` (alias SQL de `to_process_actions`). */
const derniereDecision = (a: string) => `
  SELECT d.outcome, d.reason_code FROM document_rule_evaluations d
   WHERE d.account_id = ${a}.account_id AND d.file_id = ${a}.target_id AND d.rule_code = ${a}.rule_code
   ORDER BY d.id DESC LIMIT 1`;

/** Lot 100E — sous-requête : dernière décision de famille de la carte `a` (index 0516 `to_process_decisions_target_idx`). */
const derniereDecisionFamille = (a: string) => `
  SELECT f.outcome, f.effect FROM to_process_decisions f
   WHERE f.account_id = ${a}.account_id AND f.target_type = ${a}.target_type AND f.target_id = ${a}.target_id AND f.rule_code = ${a}.rule_code
   ORDER BY f.id DESC LIMIT 1`;

const listeSql = (codes: readonly string[]) => codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ');

/**
 * Cause SQL du blocage TECHNIQUE d'une carte (`a` : alias ou nom qualifié de
 * `to_process_actions`) ; NULL si la carte n'est pas retenue. Même table de
 * correspondance que `cardStanding` / `familyCardStanding`.
 */
export function holdCauseSql(a = 'a', undeclared: readonly string[] = undeclaredCatalogRules()): string {
  return `(CASE${undeclared.length ? `
    WHEN ${a}.rule_code IN (${listeSql(undeclared)}) THEN 'RULE_NOT_DECLARED'` : ''}
    WHEN ${a}.target_type = 'DOCUMENT' THEN (SELECT CASE WHEN h.outcome = 'ERROR' THEN 'EVALUATION_ERROR' ${Object.entries(TECHNICAL_HOLD_REASONS)
    .map(([r, c]) => `WHEN h.reason_code = '${r}' THEN '${c}'`).join(' ')} END FROM (${derniereDecision(a)}) h)
    ELSE (SELECT CASE WHEN g.outcome = 'ERROR' OR g.effect = 'ERROR' THEN 'EVALUATION_ERROR'
                      WHEN g.outcome = 'DEFER' AND g.effect = 'KEPT' THEN 'DECISION_DEFERRED' END FROM (${derniereDecisionFamille(a)}) g)
  END)`;
}

/** Condition SQL « carte retenue pour blocage technique » (`a` : alias ou nom qualifié de `to_process_actions`). */
export function heldCardSql(a = 'a'): string {
  return `(${holdCauseSql(a)} IS NOT NULL)`;
}

// ══════════════════════════════════════════════════════════════════════════
// CARTE DEVENUE INUTILE (prémisse du contrat) ET CIBLE DISPARUE
// ══════════════════════════════════════════════════════════════════════════

/** Cible vivante d'une carte (SQL). Fournisseur : présumé vivant (sa prémisse lit la revue). */
export function targetAliveSql(a = 'a'): string {
  return `(CASE ${a}.target_type
    WHEN 'DOCUMENT' THEN EXISTS (SELECT 1 FROM asset_files tf WHERE tf.id = ${a}.target_id AND tf.account_id = ${a}.account_id
                                   AND tf.deleted_at IS NULL AND tf.grouped_into_file_id IS NULL)
    WHEN 'ASSET' THEN EXISTS (SELECT 1 FROM assets ts WHERE ts.id = ${a}.target_id AND ts.account_id = ${a}.account_id AND ts.deleted_at IS NULL)
    WHEN 'AGENDA_ITEM' THEN EXISTS (SELECT 1 FROM agenda_items ti WHERE ti.id = ${a}.target_id AND ti.account_id = ${a}.account_id)
    WHEN 'EQUIPMENT' THEN EXISTS (SELECT 1 FROM equipments te WHERE te.id = ${a}.target_id)
    WHEN 'ROOM' THEN EXISTS (SELECT 1 FROM substructures tr JOIN assets ta ON ta.id = tr.asset_id WHERE tr.id = ${a}.target_id AND ta.account_id = ${a}.account_id)
    ELSE true END)`;
}

/** Condition SQL « la prémisse du contrat de SA règle ne tient plus » (réponse connue, intérêt disparu). */
export function noLongerUsefulSql(a = 'a'): string {
  const clauses = Object.entries(PUBLISHABILITY_CONTRACTS)
    .filter(([, c]) => c.noLongerUseful)
    .map(([code, c]) => `(${a}.rule_code = '${code}' AND ${c.noLongerUseful!(a)})`);
  return clauses.length ? `(${clauses.join(' OR ')})` : 'false';
}

/**
 * Condition SQL « carte PUBLIABLE » — à combiner avec `resolved_at IS NULL`
 * (la carte ouverte). `a` : alias ou nom qualifié de `to_process_actions`.
 * Lot 100E : prémisse de la famille toujours vraie, aucun blocage technique.
 * Une cible disparue n'est pas jugée ici (comme avant : libellé « introuvable »,
 * fermeture par le balayage horaire et COH-TODO-ORPHAN-CARDS).
 */
export function publishableCardSql(a = 'a'): string {
  return `(NOT ${noLongerUsefulSql(a)} AND NOT ${heldCardSql(a)})`;
}

/** Même condition pour les requêtes Drizzle sur `toProcessActions` (table non aliasée). */
export function publishableCardCondition(): SQL {
  return sql.raw(publishableCardSql('"to_process_actions"'));
}

/** Statut de publication d'une carte ouverte (SQL texte) : TARGET_GONE, NO_LONGER_USEFUL, HELD:<cause>, PUBLISHABLE. */
export function publicationStandingSql(a = 'a'): string {
  return `(CASE WHEN NOT ${targetAliveSql(a)} THEN 'TARGET_GONE'
               WHEN ${noLongerUsefulSql(a)} THEN 'NO_LONGER_USEFUL'
               WHEN ${heldCardSql(a)} THEN 'HELD:' || ${holdCauseSql(a)}
               ELSE 'PUBLISHABLE' END)`;
}

export type PublicationStanding = 'TARGET_GONE' | 'NO_LONGER_USEFUL' | 'PUBLISHABLE' | `HELD:${TechnicalHoldCause}`;

type Client = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/**
 * Création / conservation (lot 100E, A7) — la prémisse du contrat tient-elle
 * pour cette carte, AVANT de l'écrire ? Même SQL que l'affichage, sur une
 * ligne virtuelle. Faux : réponse déjà connue / intérêt disparu → la carte
 * n'est ni créée ni reconduite. Ne lève jamais : une lecture impossible ne
 * bloque pas la production (l'affichage et la campagne rejugent).
 */
export async function cardPremiseStillHolds(input: {
  accountId: number; targetType: string; targetId: number; ruleCode: string; actionKind: string;
  fieldKey?: string | null; relationKey?: string | null; proposals?: unknown; triggerContext?: unknown;
}, client?: Client): Promise<boolean> {
  const c = contractOf(input.ruleCode);
  if (!c?.noLongerUseful || !c.atCreation) return true;
  try {
    const sqlc = client ?? (await import('@/db')).pgClient as unknown as Client;
    const r = (await sqlc.unsafe(
      `SELECT ${c.noLongerUseful('a')} AS stale FROM (SELECT $1::int AS account_id, $2::text AS target_type, $3::int AS target_id, $4::text AS rule_code,
              $5::text AS action_kind, $6::text AS field_key, $7::text AS relation_key, $8::jsonb AS proposals_json, $9::jsonb AS trigger_context) a`,
      [input.accountId, input.targetType, input.targetId, input.ruleCode, input.actionKind, input.fieldKey ?? null, input.relationKey ?? null,
        JSON.stringify(input.proposals ?? []), JSON.stringify(input.triggerContext ?? {})] as never[],
    )) as Array<{ stale: boolean }>;
    return r?.[0]?.stale !== true;
  } catch {
    return true;
  }
}

/**
 * Fermeture TRACÉE des cartes devenues inutiles (service générique des
 * familles sans producteur « état ») — lot 100E, A7. La fermeture n'a lieu
 * que si la carte est toujours ouverte ET toujours inutile (prémisse relue
 * dans la MÊME instruction : jamais de fermeture sur un état périmé) ;
 * événement d'audit dans la même transaction. Aucune donnée de l'objet n'est
 * écrite : les modifications de l'utilisateur sont intactes. Idempotent.
 */
export async function closeCardsNoLongerUseful(accountId: number, actionIds: readonly number[], o: { runRef?: string | null } = {}): Promise<number[]> {
  if (!actionIds.length) return [];
  const { db } = await import('@/db');
  return db.transaction(async (tx) => {
    const fermees = (await tx.execute(sql.raw(`
      UPDATE to_process_actions a SET resolved_at = now(), resolution_reason = 'OBSOLETE', updated_at = now()
       WHERE a.account_id = ${Number(accountId)} AND a.id IN (${actionIds.map((x) => Number(x)).join(', ')}) AND a.resolved_at IS NULL
         AND ${noLongerUsefulSql('a')}
      RETURNING a.id, a.target_type, a.target_id, a.rule_code, COALESCE(a.field_key, a.relation_key) AS data_key`))) as unknown as Array<Record<string, unknown>>;
    const lignes = Array.isArray(fermees) ? fermees : ((fermees as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    if (lignes.length) {
      const { toProcessActionEvents } = await import('@/db/schema');
      const now = new Date();
      await tx.insert(toProcessActionEvents).values(lignes.map((x) => ({
        actionId: Number(x.id), accountId, event: 'OBSOLETE', actorUserId: null, targetType: String(x.target_type), targetId: Number(x.target_id),
        fieldKey: (x.data_key as string | null) ?? null,
        details: { ruleCode: String(x.rule_code), reason: contractOf(String(x.rule_code))?.reason ?? 'NO_LONGER_USEFUL', source: 'A7_PUBLISHABILITY', runRef: o.runRef ?? null },
        createdAt: now,
      })));
    }
    return lignes.map((x) => Number(x.id));
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SUPERVISION ET NOUVELLE TENTATIVE
// ══════════════════════════════════════════════════════════════════════════

export interface HeldCardsGroup { cause: TechnicalHoldCause; count: number; accountIds: number[]; families?: string[] }

/**
 * Cartes OUVERTES retenues (non publiables pour blocage technique),
 * regroupées par cause — tous comptes, ou un seul compte. Une carte déjà
 * inutile ou sans cible n'y figure pas (elle est nettoyée, pas supervisée).
 * Lecture seule ; ne lève pas (0 en cas d'échec).
 */
export async function heldCardsOverview(o: { accountId?: number | null; sql?: Client } = {}): Promise<HeldCardsGroup[]> {
  try {
    const client = o.sql ?? (await import('@/db')).pgClient as unknown as Client;
    const r = (await client.unsafe(`
      SELECT x.cause, count(*)::int AS n, (array_agg(DISTINCT x.account_id))[1:20] AS accounts, array_agg(DISTINCT x.rule_code) AS rules FROM (
        SELECT a.account_id, a.rule_code, ${holdCauseSql('a')} AS cause FROM to_process_actions a
         WHERE a.resolved_at IS NULL ${o.accountId ? 'AND a.account_id = $1' : ''}
           AND ${targetAliveSql('a')} AND NOT ${noLongerUsefulSql('a')}) x
       WHERE x.cause IS NOT NULL
       GROUP BY x.cause ORDER BY 2 DESC`, (o.accountId ? [o.accountId] : []) as never[])) as Array<{ cause: TechnicalHoldCause; n: number; accounts: number[] | null; rules: string[] | null }>;
    return r.map((x) => ({
      cause: x.cause, count: Number(x.n), accountIds: (x.accounts ?? []).map(Number),
      families: [...new Set((x.rules ?? []).map((c) => { const f = familyOf(c); return f ? CARD_FAMILY_LABELS[f] : 'non déclarée'; }))].sort(),
    }));
  } catch (e) {
    console.error('[to-process] lecture des cartes retenues impossible :', (e as Error).message);
    return [];
  }
}

export interface HeldCard { accountId: number; actionId: number; targetType: string; targetId: number; fileId: number; ruleCode: string; cause: TechnicalHoldCause }

/** Cartes retenues (identifiants : compte, carte, cible, règle, cause), bornées — nouvelle tentative BO. */
export async function heldCards(o: { limit: number; accountId?: number | null }): Promise<HeldCard[]> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(`
    SELECT * FROM (
      SELECT a.account_id, a.id, a.target_type, a.target_id, a.rule_code, ${holdCauseSql('a')} AS cause FROM to_process_actions a
       WHERE a.resolved_at IS NULL ${o.accountId ? 'AND a.account_id = $2' : ''} AND ${targetAliveSql('a')} AND NOT ${noLongerUsefulSql('a')}) x
     WHERE x.cause IS NOT NULL
     ORDER BY x.id LIMIT $1`, (o.accountId ? [o.limit, o.accountId] : [o.limit]) as never[])) as unknown as Array<Record<string, unknown>>;
  return r.map((x) => ({
    accountId: Number(x.account_id), actionId: Number(x.id), targetType: String(x.target_type), targetId: Number(x.target_id),
    fileId: Number(x.target_id), ruleCode: String(x.rule_code), cause: x.cause as TechnicalHoldCause,
  }));
}

/** Producteur « état » d'une règle de famille (nouvelle tentative, nettoyage). */
const PRODUCTEUR_ETAT: Readonly<Record<string, 'produceAgendaActions' | 'produceEquipmentActions' | 'produceSupplierActions'>> = {
  'DATA-AGENDA-DATE': 'produceAgendaActions',
  'LINK-EQUIP-ASSET': 'produceEquipmentActions',
  'SUPPLIER-IDENTITY': 'produceSupplierActions',
};

/**
 * Nouvelle tentative (BO › IA › File d'attente, bouton) : réévaluation par
 * la DÉCISION CENTRALE existante des cartes retenues — documentaires
 * (`resolveDocumentRuleFromKnowledge`, budget IA du compte, anti-boucle des
 * mémoires T3 / T4) et, depuis le lot 100E, des familles « état » (leur
 * producteur restreint à la cible). Une carte dont l'utilité est démontrée
 * redevient publiable, une carte inutile est fermée, une cause qui persiste
 * la laisse retenue. Règle non déclarée : rien à retenter (contrat à
 * compléter). Bornée (`limit`, `deadline`).
 */
export async function retryHeldCards(o: { limit?: number; deadline?: number; accountId?: number | null } = {}): Promise<{ examined: number; outcomes: Record<string, number>; errors: number }> {
  const { resolveDocumentRuleFromKnowledge, syncDocumentRulesFromState } = await import('./document-rule-bridge');
  const lot = await heldCards({ limit: Math.min(200, Math.max(1, o.limit ?? 50)), accountId: o.accountId ?? null });
  const outcomes: Record<string, number> = {};
  const compter = (k: string) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };
  let errors = 0;
  let examined = 0;
  const vus = new Set<string>();
  for (const c of lot) {
    if (o.deadline && Date.now() >= o.deadline) break;
    if (c.cause === 'RULE_NOT_DECLARED') continue;
    const k = `${c.accountId}:${c.targetType}:${c.targetId}:${c.ruleCode}`;
    if (vus.has(k)) continue;
    vus.add(k);
    examined += 1;
    try {
      if (c.targetType !== 'DOCUMENT') {
        const p = PRODUCTEUR_ETAT[c.ruleCode];
        if (!p) { compter('NO_PRODUCER'); continue; }
        const producteurs = await import('./producers.service');
        const r = await producteurs[p](c.accountId, { trigger: 'BACKFILL', runRef: 'bo:retry-held-cards', only: [c.targetId] });
        compter(r.closed ? 'CLOSED' : r.created || r.updated ? 'KEPT' : 'NONE');
        continue;
      }
      const r = await resolveDocumentRuleFromKnowledge(c.accountId, c.targetId, c.ruleCode, { runRef: 'bo:retry-held-cards', trigger: 'BACKFILL' });
      if (r.status === 'NOT_A_FIELD') {
        // Règle de relation (évaluation en erreur) : réévaluation d'état de la même règle, sans création.
        const s = await syncDocumentRulesFromState(c.accountId, c.targetId, { reason: 'OBSOLETE', create: false, trigger: 'BACKFILL', runRef: 'bo:retry-held-cards' });
        compter(String(s.outcomes[c.ruleCode] ?? 'NONE'));
        continue;
      }
      compter(r.status);
    } catch (e) {
      errors += 1;
      console.error('[to-process] nouvelle tentative impossible :', (e as Error).message);
    }
  }
  return { examined, outcomes, errors };
}
