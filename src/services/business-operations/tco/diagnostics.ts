/**
 * Lot 109C — DIAGNOSTICS STRUCTURÉS du coût de possession (ticket P2 « TCO —
 * rationaliser les alertes de couverture et rendre chaque anomalie
 * contextualisée et actionnable »). PUR : aucun import serveur (fiche,
 * desktop et mobile, BO).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN SECOND MOTEUR. Les diagnostics sont DÉRIVÉS de la trace que le moteur
 * TCO vient de produire (`computeTco` : lignes économiques, entrées du
 * registre, signalements, résolution de la date de départ, état persisté de
 * la récupération des montants du lot 108B) — jamais recalculés, jamais
 * déduits de la seule présence d'un code : une occurrence = une ligne, un
 * justificatif ou un champ de la fiche réellement concerné.
 *
 * Chaque diagnostic porte : un code stable (les codes `TcoWarning` existants,
 * plus `SAME_FACT_PROVEN` et `LEDGER_ANOMALY`), une NATURE
 *   · ANOMALY      — anomalie à corriger : incertitude ou contradiction
 *                    avérée pouvant fausser un montant, le périmètre ou une
 *                    répartition, sans réparation automatique fiable ;
 *   · COVERAGE     — couverture incomplète ou traitement en cours : donnée
 *                    importante absente (ou en cours de récupération) — jamais
 *                    reprochée à l'utilisateur ;
 *   · INFORMATION  — exclusion normale ou état neutre (dépense future,
 *                    achat distinct hors périmètre, déduplication prouvée,
 *                    décision de l'utilisateur) : jamais une alerte ;
 * un STATUT (OPEN, IN_PROGRESS, INFORMATIONAL), le nombre réel
 * d'occurrences, leurs sources (ligne, justificatif, événement de référence),
 * une explication courte et l'action possible.
 *
 * Règle de sécurité : un signalement d'anomalie ou de couverture du moteur
 * dont aucune source n'est retrouvée reste AFFICHÉ (`traced: false`, nombre
 * inconnu) — une règle de présentation ne masque jamais une incohérence.
 * Lot 111V (ticket « TCO — anomalies corrigeables ») : quatre groupes
 * distincts — (1) anomalie ouverte (OPEN), (2) contrôle / récupération en
 * attente (IN_PROGRESS), (3) exclusion normale documentée (INFORMATIONAL),
 * (4) choix de l'utilisateur déjà confirmé (DECIDED). Chaque source d'un cas
 * ouvert porte ses GESTES contextuels (`actions`, calculés par
 * `tcoLineDecisionOptions`) ; une ligne arbitrée par l'utilisateur ne rouvre
 * aucun cas, sauf preuve nouvelle contraire (`USER_DECISION_TO_RECONFIRM`).
 * Les états #646 sont repris tels quels : `NO_RELIABLE_VALUATION` n'existe
 * plus ; `AMOUNTS_UNKNOWN` n'est levé qu'après l'échec réel de la récupération
 * (108B) ; `AMOUNTS_RECOVERY_PENDING` est un traitement en cours ; une
 * identité économique prouvée (108A) est une information.
 * Lot 113N (carte #712) : `ECONOMIC_DATE_UNDETERMINED` porte, pour chaque
 * dépense retenue non datée, « Conserver dans le TCO sans date », « Renseigner
 * la date » (si sa date se saisit) et « Retirer du TCO » ; une dépense
 * confirmée sans date passe dans les choix confirmés (CONFIRM_UNDATED) — seul
 * ce point est clos, jamais un autre constat de la ligne.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AMOUNT_RECOVERY_PENDING_STATES, AMOUNT_RECOVERY_VIEW_LABELS, type AmountRecoveryViewState } from './amount-recovery';
import type { TcoEconomicLine, TcoResult, TcoWarning } from './model';
import {
  TCO_ARBITRATION_DECISIONS, TCO_DATE_ACTIONS, TCO_UNDATED_LABELS, tcoLineDecisionOptions, tcoLineUndated,
  type TcoDateDecisionValue, type TcoDecisionOption, type TcoUserDecisionValue,
} from './user-decisions';

export type TcoDiagnosticNature = 'ANOMALY' | 'COVERAGE' | 'INFORMATION';
export type TcoDiagnosticStatus = 'OPEN' | 'IN_PROGRESS' | 'INFORMATIONAL' | 'DECIDED';
/** Ce que le cas peut fausser (ordre d'impact : total, périmètre, période, répartition annuelle, rien). */
export type TcoDiagnosticImpact = 'TOTAL' | 'SCOPE' | 'PERIOD' | 'ANNUAL' | 'NONE';
/** Codes stables : signalements du moteur + deux codes dérivés de la trace. */
export type TcoDiagnosticCode = TcoWarning | 'SAME_FACT_PROVEN' | 'LEDGER_ANOMALY' | 'USER_DECISION_TO_RECONFIRM';
/** Champ de la fiche du bien à compléter ou corriger (clés des champs de la fiche). */
export type TcoAssetField = 'acquisitionDate' | 'acquisitionPrice' | 'saleDate' | 'salePrice';

export type TcoDiagnosticAction =
  | { kind: 'OPEN_DOCUMENT'; label: string }
  | { kind: 'OPEN_LINE'; label: string }
  | { kind: 'ASSET_FIELD'; label: string; field: TcoAssetField };

export interface TcoDiagnosticSource {
  /** Ligne économique concernée (identifiant stable de `lines`), si elle existe. */
  lineId: string | null;
  /** Justificatif à ouvrir pour agir. */
  fileId: number | null;
  /** Justificatif lié (copie gardée, ligne comptée à la place). */
  relatedFileId: number | null;
  /** Événement de référence concerné (point d'extension : lecture unifiée 109A, BO). */
  operationId: number | null;
  /** Champ de la fiche du bien concerné. */
  assetField: TcoAssetField | null;
  label: string;
  /** Précision courte propre à l'occurrence (dates contradictoires, état de la lecture…). */
  detail: string | null;
  amountCents: number | null;
  date: string | null;
  /** La ligne est montrée sur la fiche (lien « Voir la dépense » possible). */
  visible: boolean;
  /** La ligne est retenue (« Dépenses retenues ») ou non (« Dépenses non retenues »). */
  retained: boolean;
  /** Lot 111V : clé stable de la ligne (geste envoyé au serveur). */
  lineKey?: string | null;
  /** Lot 111V : gestes contextuels possibles sur cette source (vide : aucun geste, motif suffisant). */
  actions?: TcoDecisionOption[];
  /** Lot 111V : ligne comptée à la place (doublon présumé) — libellé, date et montant retenu, pour comparer. */
  counterpart?: { label: string; date: string | null; amountCents: number | null; fileId: number | null } | null;
  /**
   * Lot 111V : choix de l'utilisateur porté par la ligne (groupe « choix confirmé »). Lot 113N : aussi la
   * confirmation « conservée sans date » (CONFIRM_UNDATED), distincte de tout choix d'inclusion / exclusion.
   */
  decision?: { value: TcoUserDecisionValue | TcoDateDecisionValue; contradicted: boolean } | null;
}

export interface TcoDiagnostic {
  code: TcoDiagnosticCode;
  nature: TcoDiagnosticNature;
  status: TcoDiagnosticStatus;
  impact: TcoDiagnosticImpact;
  /** Nombre RÉEL d'occurrences (null : signalement du moteur sans source retrouvée). */
  count: number | null;
  traced: boolean;
  /** Somme des montants connus des sources (centimes EUR), null si aucun. */
  amountCents: number | null;
  title: string;
  text: string;
  action: TcoDiagnosticAction | null;
  sources: TcoDiagnosticSource[];
  sourcesTruncated: boolean;
}

export interface TcoDiagnostics {
  /** Triés : nature (anomalie, couverture, information), impact réel, montant en jeu, nombre. */
  items: TcoDiagnostic[];
  /**
   * Cas ouverts (anomalies + couvertures OPEN) : familles et occurrences connues. Lot 111V : `decisions` —
   * nombre RÉEL de lignes distinctes qui attendent un geste (jamais le nombre de lignes non retenues).
   */
  open: { families: number; occurrences: number; anomalies: number; coverage: number; decisions: number };
  inProgress: number;
  information: number;
  /** Lot 111V : lignes portant un choix confirmé de l'utilisateur (groupe distinct, jamais une alerte). */
  decided: number;
  /** Lignes concernées par un cas ouvert (« À revoir » dans « Dépenses non retenues »). */
  reviewLineIds: string[];
  /**
   * Distinction « aucune anomalie détectée » ≠ « TCO exhaustif » : le statut
   * de complétude du moteur, inchangé (COMPLETE ne signifie jamais que toutes
   * les dépenses possibles sont connues — seulement celles de Verebona).
   */
  completeness: TcoResult['status'];
}

/** Sources transmises par diagnostic (le nombre exact reste `count`). */
export const TCO_DIAGNOSTIC_MAX_SOURCES = 50;

interface MatrixEntry {
  nature: TcoDiagnosticNature;
  impact: TcoDiagnosticImpact;
  title: (n: number | null) => string;
  text: string;
  action: TcoDiagnosticAction | null;
}

const pl = (n: number | null, un: string, plusieurs: string) => (n === 1 ? un : plusieurs);
const voirDepense: TcoDiagnosticAction = { kind: 'OPEN_LINE', label: 'Voir la dépense' };
const ouvrirJustificatif: TcoDiagnosticAction = { kind: 'OPEN_DOCUMENT', label: 'Ouvrir le justificatif' };
const champ = (field: TcoAssetField, label: string): TcoDiagnosticAction => ({ kind: 'ASSET_FIELD', field, label });

/**
 * Matrice du ticket (§3B) — INVENTAIRE COMPLET des codes (`TcoWarning` de
 * model.ts, libellés de dto.ts) : classe de présentation fondée sur le sens
 * réel du code. `Record` exhaustif : un nouveau code du moteur ne compile pas
 * sans sa classe.
 */
export const TCO_DIAGNOSTIC_MATRIX: Readonly<Record<TcoDiagnosticCode, MatrixEntry>> = {
  // ── Anomalies à corriger ──
  PRESUMED_DUPLICATES: {
    nature: 'ANOMALY', impact: 'TOTAL',
    title: (n) => pl(n, 'Même montant sur deux justificatifs d’une dépense', 'Même montant sur plusieurs justificatifs d’une dépense'),
    text: 'Le montant n’est compté qu’une fois, faute de preuve qu’il s’agit de paiements distincts. Confirmez s’il s’agit de la même dépense, ou de deux dépenses distinctes (autre échéance, autre période).',
    action: null,
  },
  UNCERTAIN_MATCHES: {
    nature: 'ANOMALY', impact: 'TOTAL',
    title: (n) => pl(n, 'Dépense peut-être déjà comptée', 'Dépenses peut-être déjà comptées'),
    text: 'Même montant qu’une autre dépense, sans preuve qu’il s’agisse de la même : la dépense est comptée. Confirmez s’il s’agit de la même dépense ou de deux dépenses distinctes.',
    action: null,
  },
  UNJUSTIFIED_AMOUNTS: {
    nature: 'ANOMALY', impact: 'TOTAL',
    title: (n) => pl(n, 'Montant absent de son justificatif', 'Montants absents de leur justificatif'),
    text: 'Le montant compté ne se retrouve pas sur le justificatif de la dépense, ou ce justificatif a été retiré. Ouvrez le justificatif pour vérifier le montant.',
    action: ouvrirJustificatif,
  },
  ACQUISITION_AMBIGUOUS: {
    nature: 'ANOMALY', impact: 'TOTAL',
    title: () => 'Achat du bien à identifier',
    text: 'Plusieurs factures d’achat pourraient correspondre à l’achat du bien. Renseignez le prix d’achat sur la fiche du bien pour lever le doute.',
    action: champ('acquisitionPrice', 'Renseigner le prix d’achat'),
  },
  STATUS_CONTRADICTIONS: {
    nature: 'ANOMALY', impact: 'TOTAL',
    title: (n) => pl(n, 'Statut et date contradictoires', 'Statuts et dates contradictoires'),
    text: 'Le statut de la dépense ne correspond pas à sa date. Ouvrez le justificatif pour corriger la date ou le statut ; le coût sera recalculé.',
    action: ouvrirJustificatif,
  },
  UNCONFIRMED_ASSET_EXPENSES: {
    nature: 'ANOMALY', impact: 'SCOPE',
    title: (n) => pl(n, 'Bien concerné à confirmer', 'Biens concernés à confirmer'),
    text: 'Ce justificatif est rattaché à une dépense dont le bien n’est pas confirmé : il n’est pas compté ici. Ouvrez-le pour confirmer le bien concerné.',
    action: ouvrirJustificatif,
  },
  ACQUISITION_DATE_UNDETERMINED: {
    nature: 'ANOMALY', impact: 'PERIOD',
    title: () => 'Date d’achat du bien incertaine',
    text: 'Plusieurs dates d’achat possibles se contredisent : le coût annuel moyen de possession n’est pas calculé (le total n’en dépend pas). Confirmez la date d’achat sur la fiche du bien.',
    action: champ('acquisitionDate', 'Confirmer la date d’achat'),
  },
  ACQUISITION_DATE_INCOHERENT: {
    nature: 'ANOMALY', impact: 'PERIOD',
    title: () => 'Date d’achat incohérente',
    text: 'La date d’achat est impossible, future ou postérieure à la cession : le coût annuel moyen de possession n’est pas calculé. Corrigez la date d’achat de la fiche.',
    action: champ('acquisitionDate', 'Corriger la date d’achat'),
  },
  INVALID_DATES: {
    nature: 'ANOMALY', impact: 'ANNUAL',
    title: (n) => pl(n, 'Date impossible ignorée', 'Dates impossibles ignorées'),
    text: 'Une date qui n’existe pas a été ignorée : la dépense est datée autrement ou rattachée à aucune année. Ouvrez le justificatif pour corriger la date.',
    action: ouvrirJustificatif,
  },
  // ── Couverture incomplète / traitement en cours ──
  AMOUNTS_UNKNOWN: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: () => 'Montant à confirmer',
    text: 'Le montant n’a pas pu être lu, même après une nouvelle lecture automatique : le justificatif n’est pas compté (jamais à 0 €) et le coût cumulé est incomplet. Ouvrez-le pour indiquer son montant.',
    action: ouvrirJustificatif,
  },
  AMOUNTS_RECOVERY_PENDING: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: (n) => pl(n, 'Montant en attente de vérification automatique', 'Montants en attente de vérification automatique'),
    text: 'Rien à faire de votre côté : l’état réel de chaque justificatif est indiqué (en file, lecture en cours, nouvelle tentative prévue ou vérification à venir).',
    action: null,
  },
  ACQUISITION_COST_MISSING: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: () => 'Prix d’achat non renseigné',
    text: 'Aucun coût d’acquisition n’est documenté : le coût cumulé ne comprend pas l’achat du bien. Renseignez le prix d’achat sur la fiche.',
    action: champ('acquisitionPrice', 'Renseigner le prix d’achat'),
  },
  DOCUMENTS_NOT_QUALIFIED: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: (n) => pl(n, 'Nature de la dépense à préciser', 'Nature des dépenses à préciser'),
    text: 'Le justificatif porte un montant dont la nature n’est pas établie : il n’est pas compté. Confirmez s’il s’agit d’une dépense de ce bien, ou corrigez le document.',
    action: ouvrirJustificatif,
  },
  UNCONVERTED_AMOUNTS: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: (n) => pl(n, 'Montant en devise étrangère', 'Montants en devise étrangère'),
    text: 'Sans contre-valeur en euros établie, le montant n’est pas compté.',
    action: ouvrirJustificatif,
  },
  UNALLOCATED_AMOUNTS: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: (n) => pl(n, 'Dépense commune à plusieurs biens', 'Dépenses communes à plusieurs biens'),
    text: 'Le montant concerne plusieurs biens sans répartition : il n’est pas compté ici.',
    action: ouvrirJustificatif,
  },
  DISPOSAL_PRICE_MISSING: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: () => 'Prix de cession non renseigné',
    text: 'Le prix de cession réalisé n’est pas documenté : le coût net final n’est pas établi.',
    action: champ('salePrice', 'Renseigner le prix de cession'),
  },
  DISPOSAL_DATE_MISSING: {
    nature: 'COVERAGE', impact: 'PERIOD',
    title: () => 'Date de cession non renseignée',
    text: 'La fin de la période de possession n’est pas établie.',
    action: champ('saleDate', 'Renseigner la date de cession'),
  },
  ACQUISITION_DATE_MISSING: {
    nature: 'COVERAGE', impact: 'PERIOD',
    title: () => 'Date d’achat non renseignée',
    text: 'La période de possession n’est pas établie : le coût annuel moyen de possession n’est pas calculé (le total n’en dépend pas).',
    action: champ('acquisitionDate', 'Renseigner la date d’achat'),
  },
  ECONOMIC_DATE_UNDETERMINED: {
    nature: 'COVERAGE', impact: 'ANNUAL',
    title: (n) => pl(n, 'Dépense sans date établie', 'Dépenses sans date établie'),
    text: 'Comptée dans le total, la dépense n’est rattachée à aucune année : les montants par année peuvent être incomplets. Elle sera datée dès qu’un justificatif le permettra.',
    action: ouvrirJustificatif,
  },
  PARTIAL_READ: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: () => 'Résultat partiel',
    text: 'Volume exceptionnel : seule une partie des éléments a pu être lue. Le résultat est partiel.',
    action: null,
  },
  LEDGER_ANOMALY: {
    nature: 'COVERAGE', impact: 'TOTAL',
    title: () => 'Calcul à confirmer',
    text: 'Un contrôle interne du calcul présente un écart : le total affiché est à confirmer.',
    action: null,
  },
  // ── Informations / exclusions normales ──
  NOT_REALIZED_EXPENSES: {
    nature: 'INFORMATION', impact: 'NONE',
    title: (n) => pl(n, 'Dépense prévue ou à venir', 'Dépenses prévues ou à venir'),
    text: 'Non encore réalisée : elle n’est comptée dans aucun indicateur tant qu’aucun paiement daté et justifié ne l’établit.',
    action: voirDepense,
  },
  NOT_OWNERSHIP_COSTS: {
    nature: 'INFORMATION', impact: 'NONE',
    title: (n) => pl(n, 'Achat distinct non incorporé', 'Achats distincts non incorporés'),
    text: 'Achat d’un objet distinct rattaché au bien sans en faire partie : non compté dans son coût de possession. Pour l’inclure, rattachez-le comme équipement ou ajoutez-le au coût de possession.',
    action: voirDepense,
  },
  SAME_FACT_PROVEN: {
    nature: 'INFORMATION', impact: 'NONE',
    title: (n) => pl(n, 'Justificatif d’une dépense déjà comptée', 'Justificatifs de dépenses déjà comptées'),
    text: 'Autre justificatif ou autre représentation d’une même dépense, identifiée avec certitude : comptée une seule fois.',
    action: voirDepense,
  },
  PRORATA_APPLIED: {
    nature: 'INFORMATION', impact: 'NONE',
    title: (n) => pl(n, 'Période comptée jusqu’à la cession', 'Périodes comptées jusqu’à la cession'),
    text: 'Une période payée dépasse la cession : seule la part jusqu’à la cession est comptée (prorata au jour).',
    action: voirDepense,
  },
  USER_DECISION_TO_RECONFIRM: {
    nature: 'ANOMALY', impact: 'TOTAL',
    title: (n) => pl(n, 'Choix à reconfirmer', 'Choix à reconfirmer'),
    text: 'Une information nouvelle contredit un choix que vous avez fait : votre choix reste appliqué. Gardez-le ou annulez-le.',
    action: null,
  },
  USER_DECISIONS: {
    nature: 'INFORMATION', impact: 'NONE',
    title: (n) => pl(n, 'Votre choix est appliqué', 'Vos choix sont appliqués'),
    text: 'Le coût de possession reflète vos choix (dépenses ajoutées, retirées, confirmées ou arbitrées), réversibles depuis les listes de dépenses.',
    action: voirDepense,
  },
  USER_INCLUDED_DUPLICATES: {
    nature: 'INFORMATION', impact: 'NONE',
    title: () => 'Ajout confirmé malgré une ressemblance',
    text: 'Vous avez ajouté une dépense qui ressemble à une dépense déjà comptée, après confirmation. Vous pouvez la retirer à tout moment.',
    action: voirDepense,
  },
};

const NATURE_RANG: Record<TcoDiagnosticNature, number> = { ANOMALY: 0, COVERAGE: 1, INFORMATION: 2 };
const IMPACT_RANG: Record<TcoDiagnosticImpact, number> = { TOTAL: 0, SCOPE: 1, PERIOD: 2, ANNUAL: 3, NONE: 4 };
const RETENUE = (l: Pick<TcoEconomicLine, 'status'>) => l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED';
const jj = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null);
const NOTE_AJOUT = 'Ajoutée au coût de possession par vous.';
/** Motifs d'une identité économique PROUVÉE (108A, lot 61) : information, jamais une alerte. */
const MEME_FAIT_PROUVE = new Set(['SAME_FACT_CROSS_SOURCE', 'SAME_AS_ASSET_PRICE', 'ASSET_PRICE_CONSOLIDATED', 'DUPLICATE_COPY', 'DUPLICATE_REFERENCE',
  'SAME_AS_EQUIPMENT_DOCUMENT', 'EQUIPMENT_PRICE_CONSOLIDATED', 'INCLUDED_IN_TOTAL_SAME_DOCUMENT', 'INCLUDED_IN_TOTAL_INVOICE', 'INCLUDED_IN_OPERATION_TOTAL']);

/** Occurrence d'une ligne de la trace. */
function deLigne(l: TcoEconomicLine, visible: boolean, detail: string | null = null, amountCents: number | null = l.amountUnknown ? null : l.eurCents): TcoDiagnosticSource {
  return {
    lineId: l.id, fileId: l.fileId ?? l.sourceFileIds?.[0] ?? null, relatedFileId: l.relatedFileId, operationId: l.operationId,
    assetField: null, label: l.label, detail, amountCents, date: l.date, visible, retained: RETENUE(l),
    lineKey: l.decisionKey ?? null,
    decision: l.userDecision?.applied ? { value: l.userDecision.decision, contradicted: !!l.userDecision.contradicted } : null,
  };
}

/** Lot 111V : la ligne porte un arbitrage de l'utilisateur, non contredit — le point qu'il clôt ne se rouvre pas. */
const arbitree = (l: TcoEconomicLine): boolean => !!l.userDecision?.applied && TCO_ARBITRATION_DECISIONS.has(l.userDecision.decision) && !l.userDecision.contradicted;

/** Lot 111V : libellé court d'un choix confirmé. */
const CHOIX: Readonly<Record<TcoUserDecisionValue, string>> = {
  INCLUDE: 'Ajoutée par vous.', EXCLUDE: 'Retirée par vous.', CONFIRM_EXCLUSION: 'Exclusion confirmée par vous.',
  SAME_FACT: 'Même dépense qu’une autre, confirmé par vous.', DISTINCT_FACTS: 'Dépense distincte, confirmé par vous.', REQUALIFY: 'Nature confirmée par vous.',
};
function sansLigne(label: string): TcoDiagnosticSource {
  return { lineId: null, fileId: null, relatedFileId: null, operationId: null, assetField: null, label, detail: null, amountCents: null, date: null, visible: false, retained: false };
}
function deChamp(field: TcoAssetField, label: string, detail: string | null = null): TcoDiagnosticSource {
  return { lineId: null, fileId: null, relatedFileId: null, operationId: null, assetField: field, label, detail, amountCents: null, date: null, visible: false, retained: false };
}

/** Précision d'une contradiction statut / date (moteur : `contradiction`, date de la ligne). */
function detailContradiction(l: TcoEconomicLine): string | null {
  const d = jj(l.date);
  if (l.contradiction === 'PLANNED_WITH_PAYMENT') return `Marquée « prévue » mais payée${d ? ` le ${d}` : ''} : comptée à sa date de paiement.`;
  if (l.contradiction === 'REALIZED_FUTURE_DATE') return `Marquée « réalisée » mais datée${d ? ` du ${d}` : ''}, après aujourd’hui : non comptée.`;
  return l.note;
}

/**
 * Lot 81D : une dépense PRÉVUE sans preuve de paiement (`PLANNED_WITHOUT_PROOF`)
 * est le fonctionnement normal d'une prévision — exclue, jamais une
 * contradiction ; seules « prévue mais payée » et « réalisée mais datée après
 * aujourd'hui » sont des contradictions réelles (aussi la règle du moteur).
 */
export const isRealContradiction = (c: string | undefined | null): boolean => c === 'PLANNED_WITH_PAYMENT' || c === 'REALIZED_FUTURE_DATE';

/** Identifiant de ligne d'une entrée du registre (composante `c:<id>`, sinon `lineId`). */
const ligneDEntree = (e: { operationId: number; componentId: number; lineId?: string }) => (e.operationId > 0 && e.componentId > 0 && !e.lineId ? `c:${e.componentId}` : e.lineId ?? null);

/**
 * Occurrences de chaque code, retrouvées dans la trace du moteur (pure).
 * `hidden` : lignes non montrées sur la fiche (`tcoUserView`).
 */
function occurrences(t: TcoResult, hidden: ReadonlySet<string>): Map<TcoDiagnosticCode, TcoDiagnosticSource[]> {
  const out = new Map<TcoDiagnosticCode, TcoDiagnosticSource[]>();
  const add = (c: TcoDiagnosticCode, s: TcoDiagnosticSource) => out.set(c, [...(out.get(c) ?? []), s]);
  const vis = (l: TcoEconomicLine) => !hidden.has(l.id);
  const parId = new Map(t.lines.map((l) => [l.id, l]));
  const ajoutee = (l: TcoEconomicLine) => !!l.userDecision?.applied && l.userDecision.decision === 'INCLUDE';

  for (const l of t.lines) {
    // Lot 113N : date non établie d'une dépense RETENUE — évaluée pour toute ligne (y compris arbitrée : un arbitrage
    // ne clôt que son propre point). Confirmée « sans date » par l'utilisateur : choix confirmé, plus un cas ouvert ;
    // sinon point ouvert (conserver sans date, renseigner la date, retirer). Aucun autre constat n'est neutralisé.
    if (tcoLineUndated(l)) {
      if (l.undatedConfirmation) add('USER_DECISIONS', { ...deLigne(l, vis(l), TCO_UNDATED_LABELS.decided, l.includedCents), decision: { value: 'CONFIRM_UNDATED', contradicted: false } });
      else add('ECONOMIC_DATE_UNDETERMINED', deLigne(l, vis(l), l.dateLabel ?? null, l.includedCents));
    }
    // Lot 111V : ligne arbitrée par l'utilisateur — aucun cas ouvert pour le point qu'il a clos ; choix rouvert par une preuve nouvelle.
    if (arbitree(l)) continue;
    if (l.userDecision?.contradicted) {
      add('USER_DECISION_TO_RECONFIRM', deLigne(l, vis(l), `${CHOIX[l.userDecision.decision]} Le traitement automatique a changé depuis (nouvelle information).`));
      continue;
    }
    // Doublon PRÉSUMÉ (même somme, même dépense, sans preuve de transaction distincte) : anomalie ciblée.
    if (l.status === 'DUPLICATE' && l.reason === 'SAME_FACT_OTHER_DOCUMENT') {
      const garde = l.duplicateOf ? parId.get(l.duplicateOf) : undefined;
      add('PRESUMED_DUPLICATES', {
        ...deLigne(l, vis(l), garde ? `Même somme que « ${garde.label} », comptée à sa place.` : 'Même somme qu’un autre justificatif de la même dépense, comptée une seule fois.'),
        counterpart: garde ? { label: garde.label, date: garde.date, amountCents: garde.includedCents || garde.eurCents, fileId: garde.fileId ?? garde.sourceFileIds?.[0] ?? null } : null,
      });
    } else if (!RETENUE(l) && l.reason && MEME_FAIT_PROUVE.has(l.reason) && vis(l)) add('SAME_FACT_PROVEN', deLigne(l, true));
    if (RETENUE(l) && l.uncertain) {
      if (l.source === 'OPERATION' && !l.identity) add('UNJUSTIFIED_AMOUNTS', deLigne(l, vis(l), 'Montant compté, introuvable sur les justificatifs de la dépense.'));
      else add('UNCERTAIN_MATCHES', deLigne(l, vis(l), l.note));
    }
    if (l.reason === 'SOURCE_WITHDRAWN') add('UNJUSTIFIED_AMOUNTS', deLigne(l, vis(l), 'Justificatif retiré de la dépense : son montant n’est plus compté par elle (le justificatif est réévalué seul).'));
    if (isRealContradiction(l.contradiction)) add('STATUS_CONTRADICTIONS', deLigne(l, vis(l), detailContradiction(l)));
    else if (l.notRealized && !RETENUE(l)) add('NOT_REALIZED_EXPENSES', deLigne(l, vis(l), l.note));
    if (l.status === 'UNCONFIRMED_ASSET' && !ajoutee(l)) add('UNCONFIRMED_ASSET_EXPENSES', deLigne(l, vis(l)));
    if (l.status === 'NOT_QUALIFIED' && l.reason !== 'AMOUNT_UNKNOWN' && !ajoutee(l)) add('DOCUMENTS_NOT_QUALIFIED', deLigne(l, vis(l)));
    if (l.status === 'UNCONVERTED') add('UNCONVERTED_AMOUNTS', deLigne(l, vis(l), `${(l.amountMinor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} ${l.currency}`, null));
    if (l.status === 'UNALLOCATED') add('UNALLOCATED_AMOUNTS', deLigne(l, vis(l)));
    if (l.reason === 'NOT_OWNERSHIP_COST') add('NOT_OWNERSHIP_COSTS', deLigne(l, vis(l), l.note));
    if (l.userDecision?.applied) {
      add('USER_DECISIONS', deLigne(l, vis(l), CHOIX[l.userDecision.decision]));
      if (ajoutee(l) && l.note?.startsWith(`${NOTE_AJOUT} `)) add('USER_INCLUDED_DUPLICATES', deLigne(l, vis(l), l.note.slice(NOTE_AJOUT.length + 1), l.includedCents));
    }
  }
  // Lot 111V : choix confirmés (arbitrages) — groupe « choix confirmé », jamais une alerte.
  for (const l of t.lines) if (arbitree(l)) add('USER_DECISIONS', deLigne(l, vis(l), CHOIX[l.userDecision!.decision]));
  // Montants inconnus : état PERSISTÉ de la récupération 108B (jamais relu à l'affichage) ; sans cet état, la trace.
  const inconnues = t.lines.filter((l) => l.amountUnknown && !arbitree(l));
  const recup = t.amountRecovery;
  if (recup?.items.length) {
    for (const i of recup.items) {
      if (!inconnues.some((x) => x.fileId === i.fileId) && t.lines.some((x) => x.fileId === i.fileId && x.amountUnknown && arbitree(x))) continue;
      const l = inconnues.find((x) => x.fileId === i.fileId);
      const s: TcoDiagnosticSource = {
        ...(l ? deLigne(l, vis(l)) : sansLigne(i.title)),
        label: i.title, fileId: i.fileId,
        detail: `${AMOUNT_RECOVERY_VIEW_LABELS[i.state as AmountRecoveryViewState].title}${i.nextAttemptAt ? ` (${i.state === 'QUEUED' ? 'en file depuis le' : 'à partir du'} ${jj(i.nextAttemptAt.slice(0, 10)) ?? ''})` : ''}`,
      };
      add(AMOUNT_RECOVERY_PENDING_STATES.has(i.state) ? 'AMOUNTS_RECOVERY_PENDING' : 'AMOUNTS_UNKNOWN', s);
    }
  } else for (const l of inconnues) add('AMOUNTS_UNKNOWN', deLigne(l, vis(l)));
  // Dates impossibles ignorées et prorata : entrées du registre (lignes correspondantes).
  for (const e of t.entries) {
    const id = ligneDEntree(e);
    const l = id ? parId.get(id) : undefined;
    if (e.dateRejected) {
      const detail = `Date « ${String(e.dateRejected).slice(0, 10)} » ignorée.`;
      add('INVALID_DATES', l ? deLigne(l, vis(l), detail) : { ...sansLigne('Dépense'), detail });
    }
    if (e.prorata && e.included && l) add('PRORATA_APPLIED', deLigne(l, vis(l), `${e.prorata.days} jour(s) sur ${e.prorata.totalDays} comptés.`, e.includedEurMinor));
  }
  // Achat du bien : plusieurs achats retenus comme acquisition (sans prix sur la fiche).
  const acquisitions = t.lines.filter((l) => RETENUE(l) && l.category === 'ACQUISITION');
  if (acquisitions.length > 1) for (const l of acquisitions) add('ACQUISITION_AMBIGUOUS', deLigne(l, vis(l), null, l.includedCents));
  // Champs de la fiche du bien (une occurrence : le champ).
  add('ACQUISITION_COST_MISSING', deChamp('acquisitionPrice', 'Prix d’achat (fiche du bien)'));
  add('ACQUISITION_DATE_MISSING', deChamp('acquisitionDate', 'Date d’achat (fiche du bien)'));
  add('ACQUISITION_DATE_INCOHERENT', deChamp('acquisitionDate', 'Date d’achat (fiche du bien)',
    t.period.startRejected ? `Date « ${t.period.startRejected.slice(0, 10)} » impossible.` : t.period.start ? `Date renseignée : ${jj(t.period.start) ?? t.period.start}.` : null));
  add('DISPOSAL_PRICE_MISSING', deChamp('salePrice', 'Prix de cession (fiche du bien)'));
  add('DISPOSAL_DATE_MISSING', deChamp('saleDate', 'Date de cession (fiche du bien)'));
  // Date d'achat indéterminée : la fiche, et les achats datés qui se contredisent (résolution du moteur, lot 107C).
  const depart = t.acquisitionStart;
  add('ACQUISITION_DATE_UNDETERMINED', deChamp('acquisitionDate', 'Date d’achat (fiche du bien)', depart?.canonical?.raw ? `Date de la fiche : ${jj(depart.canonical.raw) ?? depart.canonical.raw}.` : null));
  for (const c of depart?.candidates ?? []) {
    if (c.kind !== 'OPERATION' || !c.date || c.operationId == null || c.role === 'EQUIPMENT') continue;
    const l = t.lines.find((x) => x.operationId === c.operationId && x.fileId != null);
    add('ACQUISITION_DATE_UNDETERMINED', {
      lineId: l && vis(l) ? l.id : null, fileId: l?.fileId ?? null, relatedFileId: null, operationId: c.operationId, assetField: null,
      label: c.label ?? 'Achat du bien', detail: `Achat daté du ${jj(c.date) ?? c.date}.`, amountCents: null, date: c.date, visible: !!l && vis(l), retained: !!l && RETENUE(l),
    });
  }
  add('PARTIAL_READ', sansLigne('Lecture des éléments du bien'));
  return out;
}

/** Champs de la fiche : occurrence unique, posée seulement si le moteur a levé le code. */
const PAR_FICHE = new Set<TcoDiagnosticCode>(['ACQUISITION_COST_MISSING', 'ACQUISITION_DATE_MISSING', 'ACQUISITION_DATE_INCOHERENT', 'DISPOSAL_PRICE_MISSING', 'DISPOSAL_DATE_MISSING', 'PARTIAL_READ']);
/** Informations dérivées de la trace (affichées dès qu'une occurrence existe, sans signalement requis). */
const DERIVEES = new Set<TcoDiagnosticCode>(['SAME_FACT_PROVEN', 'NOT_REALIZED_EXPENSES', 'NOT_OWNERSHIP_COSTS', 'PRORATA_APPLIED', 'USER_DECISIONS', 'USER_INCLUDED_DUPLICATES', 'USER_DECISION_TO_RECONFIRM']);
/** Lot 111V : choix de l'utilisateur — groupe « choix confirmé » (DECIDED), distinct des exclusions normales. */
const CHOIX_CONFIRMES = new Set<TcoDiagnosticCode>(['USER_DECISIONS', 'USER_INCLUDED_DUPLICATES']);

/**
 * Diagnostics structurés d'un résultat TCO (pure, testée L109C-*). Aucune
 * lecture, aucune IA, aucun recalcul : la trace `t` suffit.
 */
export function computeTcoDiagnostics(t: TcoResult, opts: { hidden?: ReadonlySet<string> } = {}): TcoDiagnostics {
  const hidden = opts.hidden ?? new Set<string>();
  const occ = occurrences(t, hidden);
  // Lot 111V : gestes contextuels de chaque source (mêmes règles que les listes de dépenses, lignes montrées).
  const parId = new Map(t.lines.map((l) => [l.id, l]));
  const montrees = t.lines.filter((l) => !hidden.has(l.id));
  // Lot 113N : les gestes de la DATE ne figurent que sous le point « date non établie » (avec « Retirer du TCO »,
  // choix autonome) ; ce point ne propose aucun autre arbitrage de la ligne. Choix confirmés : tous les gestes
  // (l'interface n'y montre que l'annulation du choix concerné).
  const pourCode = (code: TcoDiagnosticCode, status: TcoDiagnosticStatus, o: TcoDecisionOption): boolean => {
    if (status === 'DECIDED') return true;
    const date = TCO_DATE_ACTIONS.has(o.action) || o.dateEntry === true;
    return code === 'ECONOMIC_DATE_UNDETERMINED' ? date || o.action === 'EXCLUDE' : !date;
  };
  const gestes = (code: TcoDiagnosticCode, status: TcoDiagnosticStatus) => (s: TcoDiagnosticSource): TcoDiagnosticSource => {
    const l = s.lineId ? parId.get(s.lineId) : undefined;
    return l && s.visible ? { ...s, actions: tcoLineDecisionOptions(l, montrees).filter((o) => pourCode(code, status, o)) } : { ...s, actions: [] };
  };
  // Codes levés par le moteur dont toutes les occurrences ont été arbitrées par l'utilisateur : clos (jamais « non tracé »).
  const closParChoix = (code: TcoDiagnosticCode): boolean => ((code === 'PRESUMED_DUPLICATES' || code === 'UNCERTAIN_MATCHES' || code === 'DOCUMENTS_NOT_QUALIFIED'
    || code === 'UNCONFIRMED_ASSET_EXPENSES' || code === 'UNCONVERTED_AMOUNTS' || code === 'UNALLOCATED_AMOUNTS' || code === 'AMOUNTS_UNKNOWN')
    && t.lines.some((l) => arbitree(l)))
    // Lot 113N : toutes les dépenses sans date retenues ont été confirmées « sans date » — point clos (jamais « non tracé »).
    || (code === 'ECONOMIC_DATE_UNDETERMINED' && t.lines.some((l) => tcoLineUndated(l) && !!l.undatedConfirmation));
  const warnings = new Set<string>(t.reliability.warnings);
  const items: TcoDiagnostic[] = [];
  const review = new Set<string>();
  const codes = Object.keys(TCO_DIAGNOSTIC_MATRIX) as TcoDiagnosticCode[];
  for (const code of codes) {
    const m = TCO_DIAGNOSTIC_MATRIX[code];
    const leve = code === 'LEDGER_ANOMALY' ? t.reliability.anomalies.length > 0 : warnings.has(code);
    let sources = code === 'LEDGER_ANOMALY' ? [] : (occ.get(code) ?? []);
    if (PAR_FICHE.has(code)) sources = leve ? sources.slice(0, 1) : [];
    if (code === 'ACQUISITION_DATE_UNDETERMINED' && !leve) sources = [];
    // Anomalie / couverture : seulement si le moteur l'a levée (sa règle fait foi) ; information : dès qu'une occurrence existe.
    if (DERIVEES.has(code) ? sources.length === 0 : !leve) continue;
    if (!DERIVEES.has(code) && !sources.length && closParChoix(code)) continue;
    // Code levé sans occurrence retrouvée : affiché quand même (jamais masqué), nombre inconnu.
    const traced = code === 'LEDGER_ANOMALY' ? true : sources.length > 0;
    const count = code === 'LEDGER_ANOMALY' ? t.reliability.anomalies.length : traced ? sources.length : null;
    const montants = sources.map((s) => s.amountCents).filter((v): v is number => v != null);
    const status: TcoDiagnosticStatus = CHOIX_CONFIRMES.has(code) ? 'DECIDED' : m.nature === 'INFORMATION' ? 'INFORMATIONAL' : code === 'AMOUNTS_RECOVERY_PENDING' ? 'IN_PROGRESS' : 'OPEN';
    if (status === 'OPEN') for (const s of sources) if (s.lineId) review.add(s.lineId);
    if (status === 'OPEN' || status === 'DECIDED') sources = sources.map(gestes(code, status));
    items.push({
      code, nature: m.nature, status, impact: m.impact, count, traced,
      amountCents: montants.length ? montants.reduce((a, b) => a + Math.abs(b), 0) : null,
      title: m.title(count), text: m.text, action: m.action,
      sources: sources.slice(0, TCO_DIAGNOSTIC_MAX_SOURCES), sourcesTruncated: sources.length > TCO_DIAGNOSTIC_MAX_SOURCES,
    });
  }
  // Ordre selon l'impact réel (jamais l'ordre des codes) : nature, impact, montant en jeu, nombre, puis code (stable).
  items.sort((a, b) => NATURE_RANG[a.nature] - NATURE_RANG[b.nature] || IMPACT_RANG[a.impact] - IMPACT_RANG[b.impact]
    || (b.amountCents ?? -1) - (a.amountCents ?? -1) || (b.count ?? 0) - (a.count ?? 0) || a.code.localeCompare(b.code));
  const ouverts = items.filter((d) => d.status === 'OPEN');
  const aDecider = new Set(ouverts.flatMap((d) => d.sources.filter((s) => s.lineId && (s.actions ?? []).length).map((s) => s.lineId!)));
  return {
    items,
    open: {
      families: ouverts.length,
      occurrences: ouverts.reduce((n, d) => n + (d.count ?? 0), 0),
      anomalies: ouverts.filter((d) => d.nature === 'ANOMALY').length,
      coverage: ouverts.filter((d) => d.nature === 'COVERAGE').length,
      decisions: aDecider.size,
    },
    inProgress: items.filter((d) => d.status === 'IN_PROGRESS').length,
    information: items.filter((d) => d.status === 'INFORMATIONAL').length,
    decided: new Set(items.filter((d) => d.status === 'DECIDED').flatMap((d) => d.sources.map((s) => s.lineId ?? s.label))).size,
    reviewLineIds: [...review],
    completeness: t.status,
  };
}
