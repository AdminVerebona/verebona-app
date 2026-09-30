/**
 * Classification déterministe — CDC §4.4.3, étape 1 ; CDC 15 T4-02, T4-11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE des règles de classification action / information : le
 * moteur T4 ET le chemin historique (`AgendaClassificationService`) les
 * appellent — plus aucune copie. Lot 14 : registre d'abord (T4-02), règles
 * métier stables ensuite (T4-11), motifs de titre enfin.
 *
 * Critère d'acceptation n°17 : « Aucun appel modèle n'est émis sur un cas que
 * les règles tranchent. »
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { HomeCategory, AgendaClassificationInput } from '../types';
import { getField, getEventEntry } from '@/services/canonical/registry';
import type { AgendaNature, EventBusinessType } from '@/services/canonical/registry';
import { applyBusinessRules } from './business-rules';

/**
 * Motifs d'ACTION — l'utilisateur doit intervenir physiquement ou décider.
 * Évalués AVANT les motifs informatifs. Stockage / gardiennage / reprise :
 * règle métier `CUSTODY_RETRIEVAL_ACTION` (business-rules), un seul exemplaire.
 */
const ACTION_PATTERNS: RegExp[] = [
  /contrôle technique/i, /revision/i, /révision/i,
  /réparation/i, /reparation/i,
  /renouvellement/i,
  /rendez-vous/i, /rdv/i,
  /entretien/i,
  /intervention/i,
  /installation/i,
  /inspection/i,
  /visite/i,
  /nettoyage/i,
  /remplacement/i,
  /paiement/i, /facture/i,
];

/**
 * Motifs d'INFORMATION — faits passifs, aucune action attendue.
 *
 * CDC 15 T4-11, §26 C4 : plus de règle par TYPE DE CONTRAT (« assurance =
 * information ») — les motifs `assurance.*fin`, `expiration.*assurance`,
 * `reconduction`, `renouvellement.*auto` sont retirés ; la reconduction
 * tacite RÉELLEMENT mentionnée est la règle métier
 * `TACIT_RENEWAL_INFORMATION`, qui cède devant une démarche explicite.
 */
const INFO_PATTERNS: RegExp[] = [
  /fin de garantie/i, /garantie.*expir/i, /expir.*garantie/i,
  // « Achat — Vélo » est informatif, « Achat Pneus Discount → Reprise » ne l'est pas :
  // la règle métier de reprise a déjà tranché plus haut.
  /date d['']achat/i, /^achat\b/i,
  /fabrication/i,
  /dpe/i, /diagnostic/i,
  /décennale/i,
  /échéance.*contrat/i, /fin.*contrat/i,
];

/**
 * ══════════════════════════════════════════════════════════════════════════
 * MOTEUR HISTORIQUE (`legacy`) — CONSERVÉ À L'IDENTIQUE (arbitrage lead,
 * lot 14 : « rien ne change en production sans commutateur »).
 *
 * Tant que ni `AI_T4_EFFECTS=enabled` ni l'architecture T4 `master` ne sont
 * en place, la classification est EXACTEMENT celle d'avant le lot 14 : règle
 * « champ de bien ⇒ information », motifs de gardiennage et d'assurance
 * compris. Ces motifs sont la copie de référence historique (ex-doublon de
 * `AgendaClassificationService`, qui l'appelle désormais) ; un test de parité
 * la fige.
 * ══════════════════════════════════════════════════════════════════════════
 */
const LEGACY_ACTION_PATTERNS: RegExp[] = [
  ...ACTION_PATTERNS,
  /reprise/i, /restitution/i, /récupération/i, /recuperation/i,
  /gardiennage/i, /stockage/i, /dépôt.*pneu/i, /pneu.*dépôt/i,
  /pneu.*hiver/i, /pneu.*été/i, /pneu.*saison/i,
  /fin.*contrat.*(gardiennage|stockage|dépôt|depot|pneu)/i,
  /(gardiennage|stockage|dépôt|depot|pneu).*fin.*contrat/i,
];
const LEGACY_INFO_PATTERNS: RegExp[] = [
  /fin de garantie/i, /garantie.*expir/i, /expir.*garantie/i,
  /fin.*(p[eé]riode|contrat).*assurance/i,
  /assurance.*fin/i, /assurance.*expir/i, /expiration.*assurance/i,
  /reconduction/i, /renouvellement.*auto/i,
  /date d['']achat/i, /^achat\b/i,
  /fabrication/i,
  /dpe/i, /diagnostic/i,
  /décennale/i,
  /échéance.*contrat/i, /fin.*contrat/i,
];

/** Classification historique exacte (titre seul, champ de bien ⇒ information). */
export function classifyByRulesLegacy(input: AgendaClassificationInput): HomeCategory | null {
  if (input.originType === 'asset_field') return 'information';
  const title = input.title.toLowerCase();
  for (const p of LEGACY_ACTION_PATTERNS) if (p.test(title)) return 'action';
  for (const p of LEGACY_INFO_PATTERNS) if (p.test(title)) return 'information';
  return null;
}

/**
 * Moteur de règles : `legacy` (historique exact) ou `v2` (CDC 15 T4-02,
 * T4-11 : registre, règles métier stables, motifs de titre).
 */
export type RulesEngine = 'legacy' | 'v2';

/** Origine d'une classification déterministe (traçabilité). */
export type RuleSource = 'registry' | 'business_rule' | 'pattern';

export interface RuleClassification {
  category: HomeCategory;
  source: RuleSource;
  ruleCode: string;
}

/**
 * Catégorie portée par le registre (CDC 15 T4-02) : `agendaEffect` du champ
 * d'origine (nature, businessType), sinon type métier et nature fournis ;
 * `EVENT_CATALOG.homeCategory[nature]`. `selon_evenement` ⇒ `null` : c'est
 * l'événement concret qui décide (règles, puis modèle).
 */
export function categoryFromRegistry(input: {
  originFieldKey?: string | null; businessType?: string | null; nature?: AgendaNature | null;
}): RuleClassification | null {
  const cat = registryHomeCategory(input);
  if (!cat || cat.value === 'selon_evenement') return null;
  return { category: cat.value, source: 'registry', ruleCode: `EVENT_CATALOG:${cat.businessType}:${cat.nature}` };
}

/** Catégorie brute du registre, `selon_evenement` compris, ou `null` (inconnu). */
function registryHomeCategory(input: {
  originFieldKey?: string | null; businessType?: string | null; nature?: AgendaNature | null;
}): { value: HomeCategory | 'selon_evenement'; businessType: string; nature: AgendaNature } | null {
  const effect = input.originFieldKey ? getField(input.originFieldKey)?.agendaEffect : undefined;
  const businessType = (effect?.businessType ?? input.businessType ?? null) as EventBusinessType | null;
  const nature = effect?.nature ?? input.nature ?? null;
  if (!businessType || !nature) return null;
  const entry = getEventEntry(businessType);
  const value = entry?.homeCategory[nature];
  if (!value) return null;
  return { value, businessType: entry!.businessType, nature };
}

/**
 * Classification déterministe détaillée, ou `null` si le cas est réellement
 * ambigu — seul cas où un appel modèle est justifié. Moteur `v2`, ordre :
 *   1. registre (`agendaEffect` du champ / type métier + nature) ;
 *   2. règles métier stables (business-rules, titre + description) ;
 *   3. motifs de titre.
 *
 * CDC 15 T4-02 : la règle « tout événement issu d'un champ de bien est une
 * information » est SUPPRIMÉE — elle neutralisait `nextInspection`,
 * `maintenanceDueDate`… Un champ de bien est classé selon SA nature.
 */
export function classifyByRulesDetailed(
  input: AgendaClassificationInput, engine: RulesEngine = 'legacy',
): RuleClassification | null {
  if (engine === 'legacy') {
    const c = classifyByRulesLegacy(input);
    return c === null ? null : { category: c, source: 'pattern', ruleCode: 'LEGACY' };
  }
  const registry = registryHomeCategory(input);
  if (registry && registry.value !== 'selon_evenement') {
    return { category: registry.value, source: 'registry', ruleCode: `EVENT_CATALOG:${registry.businessType}:${registry.nature}` };
  }

  const business = applyBusinessRules(`${input.title} ${input.description ?? ''}`);
  if (business) return { category: business.category, source: 'business_rule', ruleCode: business.ruleCode };

  // Registre « selon l'événement » (assurance, fin de contrat, bail,
  // expiration DPE) : aucun motif de TITRE générique (« dpe », « fin de
  // contrat ») ne tranche à la place de l'événement concret (T4-11, C4) —
  // c'est le modèle qui classe, abstention possible.
  if (registry?.value === 'selon_evenement') return null;

  const title = input.title.toLowerCase();
  for (const p of ACTION_PATTERNS) {
    if (p.test(title)) return { category: 'action', source: 'pattern', ruleCode: `ACTION:${p.source}` };
  }
  for (const p of INFO_PATTERNS) {
    if (p.test(title)) return { category: 'information', source: 'pattern', ruleCode: `INFO:${p.source}` };
  }
  return null;
}

/**
 * Retourne la catégorie si une règle tranche, `null` si le cas est réellement
 * ambigu — seul cas où un appel modèle est justifié. Moteur `legacy` par
 * défaut (« rien ne change sans commutateur ») : un appelant placé sous
 * AI_T4_EFFECTS=enabled passe `'v2'` explicitement, ou utilise
 * `classifyByRulesInMode` (`rules-engine`).
 */
export function classifyByRules(input: AgendaClassificationInput, engine: RulesEngine = 'legacy'): HomeCategory | null {
  return classifyByRulesDetailed(input, engine)?.category ?? null;
}

/** Expose les motifs pour les tests de non-régression. */
export function getClassificationPatterns(engine: RulesEngine = 'legacy'): { action: RegExp[]; information: RegExp[] } {
  return engine === 'legacy'
    ? { action: LEGACY_ACTION_PATTERNS, information: LEGACY_INFO_PATTERNS }
    : { action: ACTION_PATTERNS, information: INFO_PATTERNS };
}
