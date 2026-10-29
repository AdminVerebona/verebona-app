/**
 * Journal complet, cartes et filtres des exécutions métier — lot 84D (CDC
 * Pilotage IA V2, phase P3 : BO-01, BO-02, BO-04, BO-05, BO-07, BO-08, EXP-01,
 * R24, R60). PUR, sans import serveur : partagé par la route de liste, les
 * exports et les écrans.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CALCUL POUR LES CARTES, LA LISTE ET L'EXPORT (R24)
 *
 * Les trois lisent la MÊME projection P2 (`projectBusinessExecutions`, règle
 * temporelle `period.ts`) et la filtrent par la MÊME fonction
 * (`matchesJournalFilter`) :
 *   · carte « Échecs »      = exécutions MÉTIER d'issue FAILED      ;
 *   · carte « Incomplètes » = exécutions MÉTIER d'issue INCOMPLETE  ;
 *   · un clic sur une carte = le journal filtré sur cette issue (vue métier),
 *     donc le même nombre et les mêmes identifiants ;
 *   · l'export reçoit les mêmes paramètres (`journalFilterToParams`) et
 *     retrouve le même ensemble.
 * Une exécution TECHNIQUE (sonde, qualification, test, balayage) n'entre
 * jamais dans les cartes (BO-02, SEM-04) : elle est dans la vue technique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { periodFromQuery, type BusinessPeriod } from './period';
import {
  BUSINESS_OUTCOMES, BUSINESS_TREATMENTS,
  type BusinessExecution, type BusinessNature, type BusinessOrigin, type BusinessOutcome, type BusinessTreatment,
} from './types';

export const BUSINESS_ORIGINS: readonly BusinessOrigin[] = ['USER', 'AUTOMATIC', 'ADMIN', 'RESUME', 'TEST', 'UNKNOWN'];

/** Vue du journal (BO-02, BO-08) : métier par défaut, technique pour sondes, qualifications, tests et appels. */
export type JournalView = 'metier' | 'technique';

export interface JournalFilter {
  period: BusinessPeriod;
  /** Paramètres de période tels que saisis (repris par les liens et l'export). */
  periodParams: { days: string | null; from: string | null; to: string | null };
  treatment: BusinessTreatment | null;
  outcome: BusinessOutcome | null;
  /** null : toutes natures (export « tout ») ; défaut BUSINESS. */
  nature: BusinessNature | null;
  origin: BusinessOrigin | null;
  accountId: number | null;
}

type Params = { get(name: string): string | null };

/** Lecture tolérante des paramètres (une valeur illisible est ignorée, jamais bloquante). */
export function parseJournalFilter(p: Params, now: Date = new Date()): JournalFilter {
  const days = p.get('days');
  const from = p.get('from');
  const to = p.get('to');
  const t = p.get('treatment');
  const o = p.get('outcome');
  const n = p.get('nature');
  const g = p.get('origin');
  const a = p.get('accountId');
  return {
    period: periodFromQuery({ days, from, to }, now),
    periodParams: {
      days: days && /^\d{1,3}$/.test(days) ? days : null,
      from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null,
      to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null,
    },
    treatment: t && (BUSINESS_TREATMENTS as readonly string[]).includes(t) ? t as BusinessTreatment : null,
    outcome: o && (BUSINESS_OUTCOMES as readonly string[]).includes(o) ? o as BusinessOutcome : null,
    nature: n === 'all' ? null : n === 'TECHNICAL' ? 'TECHNICAL' : 'BUSINESS',
    origin: g && (BUSINESS_ORIGINS as readonly string[]).includes(g) ? g as BusinessOrigin : null,
    accountId: a && /^\d{1,10}$/.test(a) ? Number(a) : null,
  };
}

/** Filtre → paramètres d'URL / d'API (mêmes clés que la lecture). */
export function journalFilterToParams(f: Omit<JournalFilter, 'period'>): URLSearchParams {
  const q = new URLSearchParams();
  if (f.periodParams.from || f.periodParams.to) {
    if (f.periodParams.from) q.set('from', f.periodParams.from);
    if (f.periodParams.to) q.set('to', f.periodParams.to);
  } else if (f.periodParams.days) q.set('days', f.periodParams.days);
  if (f.treatment) q.set('treatment', f.treatment);
  if (f.outcome) q.set('outcome', f.outcome);
  q.set('nature', f.nature ?? 'all');
  if (f.origin) q.set('origin', f.origin);
  if (f.accountId !== null) q.set('accountId', String(f.accountId));
  return q;
}

/** L'exécution entre-t-elle dans le filtre ? (La période est déjà appliquée par la projection.) */
export function matchesJournalFilter(
  x: Pick<BusinessExecution, 'treatment' | 'outcome' | 'nature' | 'origin' | 'accountId'>,
  f: Pick<JournalFilter, 'treatment' | 'outcome' | 'nature' | 'origin' | 'accountId'>,
): boolean {
  return (!f.treatment || x.treatment === f.treatment)
    && (!f.outcome || x.outcome === f.outcome)
    && (!f.nature || x.nature === f.nature)
    && (!f.origin || x.origin === f.origin)
    && (f.accountId === null || x.accountId === f.accountId);
}

export interface ExecutionCards {
  /** Exécutions métier échouées (issue finale FAILED). */
  failed: number;
  /** Exécutions métier incomplètes (issue finale INCOMPLETE). */
  incomplete: number;
}

/**
 * Les deux cartes (BO-01, BO-07) : exécutions MÉTIER, chacune comptée une fois
 * selon son issue finale (BO-04). Les filtres de traitement, d'origine et de
 * compte s'appliquent ; l'issue et la nature, non (ce sont les cartes).
 */
export function cardCounts(
  rows: readonly Pick<BusinessExecution, 'treatment' | 'outcome' | 'nature' | 'origin' | 'accountId'>[],
  f: Pick<JournalFilter, 'treatment' | 'origin' | 'accountId'> = { treatment: null, origin: null, accountId: null },
): ExecutionCards {
  const base = { ...f, outcome: null, nature: 'BUSINESS' as const };
  let failed = 0;
  let incomplete = 0;
  for (const r of rows) {
    if (!matchesJournalFilter(r, base)) continue;
    if (r.outcome === 'FAILED') failed++;
    else if (r.outcome === 'INCOMPLETE') incomplete++;
  }
  return { failed, incomplete };
}

export type CardKind = 'FAILED' | 'INCOMPLETE';

// ══════════════════════════════════════════════════════════════════════════
// Lot 99A (ticket P1 T3, §3) — VUE SYNTHÉTIQUE du Journal complet
//
// Par défaut, l'écran n'affiche plus la liste mais un bloc compact : état
// global (OK / À surveiller / Incident) calculé sur les issues RÉELLES de la
// période, total, synthèse par traitement. Même projection, même filtre que
// les cartes et la liste (R24) : les nombres concordent toujours.
// ══════════════════════════════════════════════════════════════════════════

export type JournalHealth = 'OK' | 'WATCH' | 'INCIDENT';
export const JOURNAL_HEALTH_LABELS: Record<JournalHealth, string> = { OK: 'OK', WATCH: 'À surveiller', INCIDENT: 'Incident' };

/**
 * Seuils de l'état global (isolés ici : un autre choix du PO se change en un
 * point). INCIDENT : au moins `INCIDENT_MIN_FAILED` échecs, OU une part
 * d'échecs ≥ `INCIDENT_FAILED_RATE` des exécutions finales. À SURVEILLER :
 * au moins un échec, une exécution incomplète ou une issue indéterminée.
 */
export const JOURNAL_HEALTH_RULES = { INCIDENT_MIN_FAILED: 3, INCIDENT_FAILED_RATE: 0.1 } as const;

export interface TreatmentSynthesis {
  treatment: BusinessTreatment;
  total: number;
  succeeded: number;
  incomplete: number;
  failed: number;
  /** En cours (non finales). */
  notFinal: number;
  /** Sans objet (rien à faire). */
  void: number;
  undetermined: number;
}

export interface JournalSynthesis {
  health: JournalHealth;
  healthLabel: string;
  /** Motifs de l'état, en français simple (vide si OK). */
  reasons: string[];
  /** Exécutions de la vue (nature) sur la période, filtres de périmètre appliqués, toutes issues. */
  total: number;
  finals: number;
  byTreatment: TreatmentSynthesis[];
}

const pluriel = (n: number, s: string, p = `${s}s`) => `${n} ${n > 1 ? p : s}`;

/**
 * Synthèse de la vue (pure) : mêmes filtres que les cartes — traitement,
 * origine, compte et NATURE de la vue ; l'issue n'est pas filtrée (c'est la
 * synthèse des issues). Seuls les traitements ayant au moins une exécution
 * sont listés.
 */
export function journalSynthesis(
  rows: readonly Pick<BusinessExecution, 'treatment' | 'outcome' | 'nature' | 'origin' | 'accountId'>[],
  f: Pick<JournalFilter, 'treatment' | 'origin' | 'accountId' | 'nature'>,
): JournalSynthesis {
  const base = { treatment: f.treatment, origin: f.origin, accountId: f.accountId, nature: f.nature ?? 'BUSINESS', outcome: null };
  const par = new Map<BusinessTreatment, TreatmentSynthesis>();
  for (const r of rows) {
    if (!matchesJournalFilter(r, base)) continue;
    const t = par.get(r.treatment) ?? { treatment: r.treatment, total: 0, succeeded: 0, incomplete: 0, failed: 0, notFinal: 0, void: 0, undetermined: 0 };
    t.total++;
    switch (r.outcome) {
      case 'SUCCEEDED': t.succeeded++; break;
      case 'INCOMPLETE': t.incomplete++; break;
      case 'FAILED': t.failed++; break;
      case 'NOT_FINAL': t.notFinal++; break;
      case 'VOID': t.void++; break;
      default: t.undetermined++;
    }
    par.set(r.treatment, t);
  }
  const byTreatment = BUSINESS_TREATMENTS.map((t) => par.get(t)).filter((x): x is TreatmentSynthesis => !!x);
  const sum = (k: keyof Omit<TreatmentSynthesis, 'treatment'>) => byTreatment.reduce((n, x) => n + x[k], 0);
  const failed = sum('failed');
  const incomplete = sum('incomplete');
  const undetermined = sum('undetermined');
  const finals = sum('succeeded') + incomplete + failed;
  const reasons: string[] = [];
  const detail = (k: 'failed' | 'incomplete' | 'undetermined') => byTreatment.filter((x) => x[k] > 0).map((x) => `${x.treatment} : ${x[k]}`).join(', ');
  if (failed > 0) reasons.push(`${pluriel(failed, 'échec')} sur ${pluriel(finals, 'exécution finale', 'exécutions finales')} (${detail('failed')})`);
  if (incomplete > 0) reasons.push(`${pluriel(incomplete, 'exécution incomplète', 'exécutions incomplètes')} (${detail('incomplete')})`);
  if (undetermined > 0) reasons.push(`${pluriel(undetermined, 'issue indéterminée', 'issues indéterminées')} (${detail('undetermined')})`);
  const health: JournalHealth = failed >= JOURNAL_HEALTH_RULES.INCIDENT_MIN_FAILED
    || (failed > 0 && finals > 0 && failed / finals >= JOURNAL_HEALTH_RULES.INCIDENT_FAILED_RATE)
    ? 'INCIDENT'
    : failed + incomplete + undetermined > 0 ? 'WATCH' : 'OK';
  return { health, healthLabel: JOURNAL_HEALTH_LABELS[health], reasons, total: sum('total'), finals, byTreatment };
}

/** Filtre appliqué par un clic sur une carte : même période, même périmètre, issue de la carte, vue métier. */
export function cardJournalFilter<F extends Omit<JournalFilter, 'outcome' | 'nature'>>(f: F, card: CardKind): F & Pick<JournalFilter, 'outcome' | 'nature'> {
  return { ...f, outcome: card, nature: 'BUSINESS' };
}

/** Ordre du journal : plus récente d'abord, identifiant en départage (déterministe). */
export function compareJournal(a: Pick<BusinessExecution, 'referenceAt' | 'id'>, b: Pick<BusinessExecution, 'referenceAt' | 'id'>): number {
  return b.referenceAt.getTime() - a.referenceAt.getTime() || a.id.localeCompare(b.id);
}

/** Empreinte stable d'un périmètre d'export (contrôle de reprise, manifeste). */
export function journalFilterFingerprint(f: Omit<JournalFilter, 'periodParams'>): string {
  return JSON.stringify({
    from: f.period.from.toISOString(), to: f.period.to.toISOString(), treatment: f.treatment, outcome: f.outcome,
    nature: f.nature, origin: f.origin, accountId: f.accountId,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// BO-11 — une source d'alerte par nature d'incident
// ══════════════════════════════════════════════════════════════════════════

type AlertNature =
  | 'BUSINESS_FAILED' | 'BUSINESS_INCOMPLETE' | 'MODEL_INCIDENT' | 'CONFIGURATION_UNSERVABLE'
  | 'QUALIFICATION_INCONCLUSIVE' | 'CALL_INCIDENT' | 'GENERAL_INCIDENT';

/**
 * Lieu UNIQUE où chaque nature d'incident est signalée (BO-11, décision PO 12 :
 * Configuration = paramétrage ; Exécutions & logs = diagnostic ; Supervision =
 * suivi transverse). Les autres écrans peuvent y RENVOYER, sans répéter ni
 * le signalement ni ses comptages (C-Q9).
 */
export const ALERT_SOURCES: Readonly<Record<AlertNature, { screen: string; where: string }>> = {
  BUSINESS_FAILED: { screen: '/admin/ai-executions', where: 'Exécutions & logs › carte « Échecs »' },
  BUSINESS_INCOMPLETE: { screen: '/admin/ai-executions', where: 'Exécutions & logs › carte « Incomplètes » (couverture partielle comprise)' },
  CALL_INCIDENT: { screen: '/admin/ai-executions', where: 'Exécutions & logs › Journal complet › vue technique (incidents d’appels)' },
  MODEL_INCIDENT: { screen: '/admin/ai-dashboard', where: 'Tableau de bord IA › alertes (échecs consécutifs d’un modèle, MOD-008)' },
  CONFIGURATION_UNSERVABLE: { screen: '/admin/ai-config', where: 'Configuration IA › avertissement contextuel (modèle actif indisponible)' },
  QUALIFICATION_INCONCLUSIVE: { screen: '/admin/ai-config', where: 'Configuration IA › registre des modèles (statut du dernier contrôle)' },
  GENERAL_INCIDENT: { screen: '/admin/supervision', where: 'Supervision (traitement suspendu, capture des échanges en défaut)' },
};
