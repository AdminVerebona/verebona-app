/**
 * Règles métier STABLES de classification agenda — CDC 15 T4-11, §26 (C4).
 *
 * UN SEUL EXEMPLAIRE. Ces deux règles vivaient en dur dans le prompt
 * `classify_event_v2` (R1, R3) ET dans le prompt inline de
 * `AgendaClassificationService` : deux copies d'une même règle dérivent.
 * Elles sont désormais des règles déterministes, évaluées AVANT tout appel
 * modèle, par le moteur (`deterministic-classification`) comme par le chemin
 * historique (`AgendaClassificationService`). Le prompt maître T4 ne les
 * contient pas (C4 : « N'applique pas de règle générale par type de
 * contrat »).
 *
 * T4-11 — « classifier l'événement réel, pas le type de contrat » : la règle
 * d'assurance ne porte plus sur « assurance », mais sur la mention concrète
 * d'une reconduction tacite, et CÈDE devant une action explicite (résilier,
 * renvoyer, signer, payer…) — recette : « échéance assurance demandant une
 * action explicite doit rester action ».
 */
import type { HomeCategory } from '../types';

export interface AgendaBusinessRule {
  code: string;
  category: HomeCategory;
  description: string;
  /** Texte évalué : titre + description / extrait, en minuscules. */
  matches: (text: string) => boolean;
}

/** Démarche explicite demandée à l'utilisateur. */
const EXPLICIT_ACTION = /(résili|resili|à renvoyer|a renvoyer|renvoyer|retourner|signer|signature requise|à régler|a regler|payer|paiement|démarche|demarche|contacter|prendre rendez|avant le \d)/i;

const TACIT_RENEWAL = /(reconduction tacite|tacite reconduction|tacitement reconduit|reconduit tacitement|renouvellement automatique|renouvel[ée] automatiquement|se renouvelle automatiquement)/i;

const CUSTODY = /(gardiennage|stockage|dépôt.*pneu|depot.*pneu|pneu.*d[ée]p[ôo]t|restitution|r[ée]cup[ée]ration|reprise.*(pneu|v[ée]hicule|objet|d[ée]p[ôo]t)|pneu.*(hiver|[ée]t[ée]|saison))/i;

export const AGENDA_BUSINESS_RULES: readonly AgendaBusinessRule[] = [
  {
    code: 'CUSTODY_RETRIEVAL_ACTION',
    category: 'action',
    description: 'Stockage, gardiennage, dépôt : une reprise physique est requise (ex-R3 / « préférer action »).',
    matches: (t) => CUSTODY.test(t),
  },
  {
    code: 'TACIT_RENEWAL_INFORMATION',
    category: 'information',
    description: 'Reconduction tacite mentionnée, sans démarche explicite demandée : le contrat se renouvelle seul (ex-R1).',
    matches: (t) => TACIT_RENEWAL.test(t) && !EXPLICIT_ACTION.test(t),
  },
];

/** Première règle métier applicable, ou `null`. */
export function applyBusinessRules(text: string): { category: HomeCategory; ruleCode: string } | null {
  const t = text.toLowerCase();
  for (const r of AGENDA_BUSINESS_RULES) {
    if (r.matches(t)) return { category: r.category, ruleCode: r.code };
  }
  return null;
}
