/**
 * Réponses structurées CANONIQUES — CDC 15 T2-04, T2-15, T2-22, T2-23,
 * T2-24, T2-32 (lot 15). Appelées par `data-answer.service` (niveau 1) ;
 * aucun appel modèle.
 *
 *   · structured.asset_field          « Quel est le kilométrage de la Clio ? »,
 *                                     « Quand ai-je acheté la maison ? » — un champ
 *                                     du registre lu par `readCanonicalField`
 *                                     (valeur, origine, preuve, conflit ouvert),
 *                                     source `asset_field:<id>:<clé>` ;
 *   · structured.upcoming_agenda      « Quelles échéances arrivent bientôt ? » —
 *                                     fenêtre (« 3 prochains mois », défaut 30 j),
 *                                     tri, statut prévisionnel, HISTORICAL exclu ;
 *   · structured.missing_information  « Qu'est-ce qui manque sur mes fiches ? » —
 *                                     règles de complétude du registre + À traiter ;
 *   · structured.sum_qualified        « Combien ai-je dépensé en entretien ? » —
 *                                     dépenses qualifiées par thème, couverture
 *                                     incomplète signalée, jamais de somme brute.
 */
import { coverageFactsText } from '@/lib/documents/business-period-surfaces';
import { aggregateAllowed, type ScopeCardinality } from '../core/scope-cardinality';
import { listFields, type CanonicalFieldDef } from '@/services/canonical/registry';
import type { Claim, RetrievedSource } from '../types/sources';
import type { AccountDataPort, AssetRow } from '../core/data-answer.service';
import {
  daysBetween, deFr, formatAmountCents, formatDateFr, formatListBlocks, formatNoResult, formatRelativeDays, joinFr, listItems,
} from '../core/deterministic-format';
import { composeAnswerText, type AnswerPart } from '@/lib/verebona/answer-compose';
import { METRIC_CAPTION_MAX } from '@/lib/verebona/answer-blocks';
import { assetFieldSource, assetFieldSourceId, type CanonicalFieldReading } from './field-reader';
import {
  EXPENSE_THEME_LABELS, expenseThemeOf, expenseSumSource, expenseItemsLabel, mixedExpenseNotes, type QualifiedExpenses,
} from './expenses';
import {
  claimSourceId, costLineSource, formatEur, formatMinorAmount, specificCostTerms,
  type AssetHistoryEntry, type ClaimOverview, type ContractOverview, type OperationCostRead, type PaymentsRead,
} from './operations';
import { expenseThemeWords, type ExpenseTheme } from './expense-classes';
import { findReadableFields, purchaseMention } from './field-vocabulary';
import { semanticResidue, textMatchesTerms } from '../core/semantic-scope';
import { plain } from '../core/routing-text';
import { asksSettlement } from '../core/question-focus';
import { TCO_PREMIUM_MESSAGE } from '@/services/business-operations/tco/dto';
import { stripOutsideNames, wholeWords } from './phrase-strip';
import { diagnosticMessage, type T2Diagnostic } from '../core/t2-diagnostics';

interface ScopeLike {
  assets: AssetRow[]; ambiguous: boolean; unresolved: boolean; label: string | null; cardinality?: ScopeCardinality;
  /** Carte #880 (R03) : comment le bien a été résolu (trace, aucun contenu). */
  resolvedBy?: 'CLARIFICATION' | 'NAME' | 'PAGE_CONTEXT' | null;
}

/**
 * Carte #880 (R03) — trace d'une LECTURE MÉTIER (codes et identifiants, aucun
 * contenu) : besoin reconnu, stratégie candidate et exécutée, méthode de
 * résolution du bien, issue FONCTIONNELLE (distincte du succès technique),
 * motif de l'absence d'appel IA. Portée par `CascadeTrace.businessReading`.
 */
export interface BusinessReadingTrace {
  reading: 'OWNERSHIP_COST';
  strategyCandidate: 'structured.ownership_cost';
  strategyExecuted: 'structured.ownership_cost' | null;
  /** Forme de la question : EXPLICITE (« coût de possession », « TCO ») ou large (« au total »). */
  phrasing: 'EXPLICIT' | 'BROAD';
  assetResolution: 'CLARIFICATION' | 'NAME' | 'PAGE_CONTEXT' | 'SINGLE_ASSET' | 'AMBIGUOUS' | 'NOT_FOUND' | 'NONE';
  assetId: number | null;
  outcome: 'ANSWERED' | 'LOCKED' | 'CLARIFICATION' | 'TARGET_NOT_FOUND' | 'TARGET_UNAVAILABLE' | 'READ_ERROR' | 'NO_ASSET';
  /** Pourquoi aucun modèle n'a été appelé : la lecture déterministe a conclu. */
  aiCall: 'NOT_NEEDED_DETERMINISTIC';
}

type CanonicalStrategy =
  | 'structured.asset_field' | 'structured.upcoming_agenda' | 'structured.missing_information' | 'structured.sum_qualified'
  // Lot 45 (O6) : lecture « Opération d'abord » (CDC Opérations V1 C15).
  | 'structured.operation_history' | 'structured.claim_status' | 'structured.payments' | 'structured.acquisition_price'
  | 'structured.contracts' | 'structured.operation_cost'
  // Lot 54D (§4.3) : coût de possession (service TCO).
  | 'structured.ownership_cost';

type CanonicalLevel1 =
  | {
    strategy: CanonicalStrategy; answer: string; sources: RetrievedSource[]; claims: Claim[]; kind: 'exact' | 'list' | 'calc' | 'no_result' | 'conflict';
    /** Carte #880 : motif DIAGNOSTIQUÉ d'une réponse sans valeur (`core/t2-diagnostics`). */
    diagnostic?: T2Diagnostic;
    reading?: BusinessReadingTrace;
  }
  | { ambiguous: AssetRow[]; reason: string; reading?: BusinessReadingTrace }
  | ScopeUnresolved
  | null;

/**
 * Lot 49 (STRONG / WEAK) : une stratégie structurée était CANDIDATE, mais un
 * sujet significatif de la question (`terms`, « internet ») n'est consommé
 * par rien — elle n'est PAS exécutée (jamais d'élargissement silencieux à
 * une catégorie générique) ; T2 (UNDERSTAND) reprend la main.
 */
export interface ScopeUnresolved {
  scopeUnresolved: { strategyCandidate: CanonicalStrategy; terms: string[]; assetIds: number[] };
}

/** Réponse structurée prête (sans ambiguïté). */
type CanonicalAnswer = Extract<NonNullable<CanonicalLevel1>, { strategy: CanonicalStrategy }>;

const claim = (key: string, text: string, sources: RetrievedSource[], derivation: Claim['derivation']): Claim =>
  ({ claimKey: key, text, sourceIds: sources.map((s) => s.id), derivation });
const assetSrc = (a: AssetRow): RetrievedSource =>
  ({ id: `asset_${a.id}`, type: 'asset_field', title: a.name, content: [a.category, a.subtype].filter(Boolean).join(' · '), relevanceScore: 1, meta: { assetId: a.id } });

// ── Champ du registre désigné par une question (T2-22) ─────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Champ LISIBLE désigné par le message ; la formulation la plus longue gagne
 * (pure, testée). Lot 29 (ticket 8a §A) : un champ `sensitive` (adresse) est
 * lisible par son propriétaire — la sensibilité protège la valeur vis-à-vis
 * du modèle et des traces (`assetFieldSource`), pas la réponse déterministe.
 * Vocabulaire : `field-vocabulary.ts` (registre canonique seul).
 */
/**
 * Invitation à compléter les documents non comptés, construite sur les
 * motifs RÉELS (lot 69) : la nature seule, la date seule, ou les deux —
 * jamais « (type, date du document) » quand un seul manque.
 */
export function expenseCompletionHint(sansNature: number, sansDate: number): string {
  const champs = [sansNature > 0 ? 'leur type' : null, sansDate > 0 ? 'leur date' : null].filter(Boolean) as string[];
  if (!champs.length) return 'Complétez-les pour obtenir un total fiable.';
  return `Précisez ${champs.join(' et ')} pour obtenir un total fiable.`;
}

export function findReadableField(message: string): { def: CanonicalFieldDef; phrase: string } | null {
  const toutes = findReadableFields(message).filter((x) => listFields().some((d) => d.key === x.def.key));
  const best = [...toutes].sort((a, b) => b.phrase.length - a.phrase.length)[0];
  return best ? { def: best.def, phrase: best.phrase } : null;
}

/** « Quand ai-je acheté… » : la date d'achat, champ `acquisitionDate` (T2-23). */
function purchaseQuestion(message: string): { def: CanonicalFieldDef; phrase: string } | null {
  const x = purchaseMention(message);
  return x ? { def: x.def, phrase: x.phrase } : null;
}

/**
 * Forme d'une demande portant sur un champ (pure, testée) — lot 53 (53H) :
 *   · `question`     question de LECTURE explicite (« Quelle est la date
 *                    d'achat de la Polo ? ») : compréhension déterministe
 *                    complète, lecture directe ;
 *   · `command`      commande d'écriture (« Mets le kilométrage… ») : jamais
 *                    une lecture (fast-path d'écriture inchangé) ;
 *   · `count`        comptage (« combien de… ») : pas la valeur d'un champ ;
 *   · `undetermined` rien de tout cela (« date d'achat polo ») : la forme et
 *                    l'intention ne sont PAS complètement déterminées — c'est
 *                    un signal de compréhension incomplète (→ UNDERSTAND),
 *                    jamais une raison d'abandonner le champ.
 * Mêmes motifs qu'avant le lot 53 : aucune formulation ajoutée.
 */
type FieldRequestForm = 'question' | 'command' | 'count' | 'undetermined';
export function fieldRequestForm(message: string): FieldRequestForm {
  const m = plain(message);
  if (/\b(combien de|nombre de)\b/.test(m)) return 'count';
  if (/^\s*(mets|met|modifie|change|remplace|fixe|corrige|renseigne)\b/.test(m)) return 'command';
  return /\?|\b(quel|quelle|quels|quelles|quand|combien|rappelle|donne|indique|dis-moi|c'est quoi|a quelle date)\b/.test(m) ? 'question' : 'undetermined';
}

/** Question de LECTURE (pas une commande, pas un comptage) (pure, testée). */
export function isFieldQuestion(message: string): boolean {
  return fieldRequestForm(message) === 'question';
}

// ── Échéances à venir (T2-15) ──────────────────────────────────────────────

/** Liste d'échéances demandée ; fenêtre en jours, ou `undefined` (pure, testée). */
export function upcomingAgendaRequest(message: string): { windowDays: number } | null {
  const m = plain(message);
  const liste = /\b(echeances|rendez-vous|evenements|rappels|dates importantes)\b/.test(m);
  const futur = /\b(bientot|a venir|prochain(e)?s?|arrivent|cette semaine|ce mois|dans les?)\b/.test(m);
  if (!liste || !futur) return null;
  const n = /\b(\d{1,3})\s+(prochains?\s+)?(jours?|semaines?|mois|ans?)\b/.exec(m) ?? /\bprochain(?:e)?s?\s+(\d{1,3})\s+(jours?|semaines?|mois)\b/.exec(m);
  if (n) {
    const q = Number(n[1]);
    const u = n[n.length - 1];
    const jours = /^jour/.test(u) ? q : /^semaine/.test(u) ? q * 7 : /^mois/.test(u) ? q * 31 : q * 365;
    return { windowDays: Math.min(Math.max(jours, 1), 730) };
  }
  if (/\bcette semaine\b/.test(m)) return { windowDays: 7 };
  if (/\bce mois\b/.test(m)) return { windowDays: 31 };
  if (/\bcette annee\b/.test(m)) return { windowDays: 365 };
  return { windowDays: 30 };
}

const MISSING = /\b(manque|manquent|manquant|manquante|manquantes|manquants|incomplete?s?|a completer|pas renseigne\w*|non renseigne\w*)\b/;
const SPEND = /\b(depense|depenses|depensee?s?|coute|coutes?|paye|payes?|total|somme|montant total)\b/;
const COUNT = /\b(combien|nombre)\b/;

// ── Lot 45 (O6) : intentions « Opération d'abord » (pures, testées) ─────

/** Question sur un sinistre (état, indemnité, dossier). */
export const CLAIM_Q = /\bsinistres?\b/;
const CLAIM_ASK = /\b(ou en (est|sont)|statut|etat|avancement|indemni\w*|rembourse\w*|dossiers?|suivi|quels?|quelles?|mes|mon|combien|ai-je|declare\w*|expert\w*)\b/;
// Carte #880 (R01) : mots ENTIERS seulement — jamais une sous-chaîne d'un nom de bien.
const CLAIM_STRIP = wholeWords(/sinistres?|o[uù] en (est|sont)|statut|[ée]tat|avancement|indemni\w*|rembours\w*|dossiers?|suivi|d[ée]clar\w*|expert\w*/);

/**
 * Historique d'un bien (« qu'est-ce qui a été fait sur la Polo ? », « quelles
 * réparations sur la maison ? », « historique des interventions »).
 */
export const HISTORY_Q = /(qu'?est-ce qu'?(il|on) a ete fait|qu'?est-ce qui a ete (fait|realise)|ce qui a ete (fait|realise)|que s'?est-il passe|qu'?a-t-on fait|quel(le)?s? (interventions?|reparations?|travaux|entretiens?|operations?)\b(?! (prevue?s?|a venir|prochaine?s?))|historique des (interventions|reparations|travaux|entretiens|depenses)|(interventions?|travaux|reparations?) (realise(e)?s?|faite?s?|effectue(e)?s?) (sur|dans|a|au|pour))/;
/** Une question sur l'avenir (« prévus », « à faire ») n'est pas un historique : Agenda / actions. */
const HISTORY_NOT = /\b(prevue?s?|a venir|prochaine?s?|planifie\w*|futur\w*|dois|devrai\w*|faut|a faire|a prevoir)\b/;
// Carte #880 (R01) : mots ENTIERS seulement — jamais une sous-chaîne d'un nom de bien.
const HISTORY_STRIP = wholeWords(/qu['’]?est-ce qu['’]?(il|on) a [ée]t[ée] fait|qu['’]?est-ce qui a [ée]t[ée] (fait|r[ée]alis[ée])|ce qui a [ée]t[ée] (fait|r[ée]alis[ée])|que s['’]?est-il pass[ée]|qu['’]?a-t-on fait|historique|interventions?|r[ée]parations?|travaux|entretiens?|op[ée]rations?|r[ée]alis[ée]e?s?|faite?s?|effectu[ée]e?s?|quel(le)?s?/);

/**
 * Lot 54D (§4.3) : question de COÛT DE POSSESSION d'un bien (« combien m'a
 * coûté la Polo au total ? », « coût de possession », « TCO ») — T2 lit le
 * service TCO, jamais un calcul parallèle.
 */
export const TCO_Q = /\b(couts? (total|totaux|global|globaux|complet|reel) de (possession|detention)|couts? annuels? (moyens? )?(de (possession|detention))?|couts? nets? (estimes? )?(de (possession|detention))?|couts? de (possession|detention)|tco|cout total|cout global|au total (m'?a|a) coute|m'?a coute au total|combien (m'?a|a) coute .*\bau total\b|combien (me|m'?a) coute (de|d') ?(posseder|avoir))\b/;
/** Question de coût de possession (pure) : un thème (« coût total des réparations ») ou une année reste un total de dépenses (T2-24). */
export function isOwnershipCostQuestion(message: string): boolean {
  const m = plain(message);
  return TCO_Q.test(m) && !expenseThemeOf(message) && !/\b(19|20)\d{2}\b/.test(m);
}
// Carte #880 (R01) : mots ENTIERS seulement — jamais une sous-chaîne d'un nom de bien.
/**
 * Carte #880 (R02) : forme EXPLICITE d'une question de coût de possession —
 * « coût (total) de possession / détention », « coût annuel / net de
 * possession », « TCO ». Elle vise toujours UN bien : une désignation
 * introuvable est un diagnostic (« bien non identifié »), jamais une
 * recherche documentaire. Les formes larges (« combien m'a coûté … au
 * total ») gardent la barrière sémantique (#419) et la compréhension.
 */
export const TCO_EXPLICIT_Q = /\b(couts? (total|totaux|global|globaux|complet|reel) de (possession|detention)|couts? (annuels? (moyens? )?|nets? (estimes? )?)?de (possession|detention)|tco)\b/;
export function isExplicitOwnershipCostQuestion(message: string): boolean {
  return isOwnershipCostQuestion(message) && TCO_EXPLICIT_Q.test(plain(message));
}
const TCO_STRIP = wholeWords(/co[uû]ts? (total|totaux|global|globaux|complet|r[ée]el) de (possession|d[ée]tention)|co[uû]ts? annuels?( moyens?)?|co[uû]ts? nets?( estim[ée]s?)?|co[uû]ts? de (possession|d[ée]tention)|tco|co[uû]t total|co[uû]t global|au total|combien|m['’]?a|co[uû]t[ée]?|me|de|d['’]|poss[ée]der|avoir|quel|est|le|la|mon|ma/);

/**
 * Carte #880 : désignation d'un bien introuvable, telle que l'utilisateur l'a
 * écrite (mots de la question déjà retirés, mots ENTIERS) — pour le message
 * « bien non identifié ». Jamais une sous-chaîne de nom.
 */
function designationOf(reste: string): string | null {
  const t = reste.replace(/[?!.…,;:«»"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 60) : null;
}

/** « payé / réglé » (C15) — distinct de « coûté / dépensé » (F-132, F-133). */
export const PAID = /\b(paye|payee|payes|payees|payer|regle|reglee|regles|reglees|regler|acquitte(e|es|s)?|verse|versee|versees)\b/;
/** Lot 114A (#753) : question LARGE sur le coût (« combien m'a coûté… ») — pas « payé », pas un thème. */
const BROAD_COST = /\b(coute|coutee?s?|couter)\b/;
const COST_WORDS = /\b(coute|coutee|coutes|cout|couts|depense\w*)\b/;
const PAID_YESNO = /\b(a-t-(il|elle) ete|ont-(ils|elles) ete|est-(il|elle)|sont-(ils|elles)|deja)\b/;
// Carte #880 (R01) : mots ENTIERS seulement — jamais une sous-chaîne d'un nom de bien.
const PAID_STRIP = wholeWords(/pay[ée]e?s?|payer|r[ée]gl[ée]e?s?|r[ée]gler|acquitt[ée]e?s?|vers[ée]e?s?|combien|ai-je|j['’]ai|deja|déjà|a-t-(il|elle)|est-(il|elle)|[ée]t[ée]/);

/** Question sur un contrat (assurance, abonnement, entretien, location). */
export const CONTRACT_Q = /\b(contrats?|polices? d'assurance)\b|\b(assurances?|abonnements?)\b.*\b(quel|quelle|quels|quelles|mes|ai-je|en cours|souscrit\w*)\b|\b(quel|quelle|quels|quelles|mes)\b.*\b(assurances?|abonnements?)\b/;
const CONTRACT_ASK = /\b(quel|quelle|quels|quelles|mes|ai-je|en cours|souscrit\w*|liste|qui|aupres de qui|chez qui)\b/;
const CONTRACT_NOT = /\b(expire\w*|expiration|echeance\w*|renouvel\w*|fin de|combien|retrouve\w*|montre|affiche|ouvre|cherche\w*|resilie\w*|comment)\b/;
// Carte #880 (R01) : mots ENTIERS seulement — jamais une sous-chaîne d'un nom de bien.
const CONTRACT_STRIP = wholeWords(/contrats?|polices?|assurances?|abonnements?|en cours|souscrits?|aupr[eè]s de qui|chez qui|quel(le)?s?/);

/**
 * Lot 49 : noms GÉNÉRIQUES d'une dépense (pièce, frais, intervention) — ils
 * désignent la dépense elle-même, jamais un sujet précis.
 */
const MOTS_DEPENSE = ['facture', 'factures', 'document', 'documents', 'frais', 'intervention', 'interventions', 'operation', 'operations', 'achats'];

/**
 * Carte #880 (R01) : autres prétraitements des stratégies déterministes —
 * mêmes listes qu'avant, en mots ENTIERS (informations manquantes, thème de
 * dépense, échéances).
 */
const MISSING_STRIP = wholeWords(/informations?|manqu\w*|incompl\w*|compl[eé]ter|renseign\w*/);
const THEME_STRIP = wholeWords(`${Object.values(EXPENSE_THEME_LABELS).map(esc).join('|')}|entretien|revision|reparations?|travaux|assurances?|achat`);
const AGENDA_STRIP = wholeWords(/[ée]ch[ée]ances?|rendez-vous|[ée]v[ée]nements?|rappels?|bient[ôo]t|arrivent|prochaine?s?|[àa] venir/);

const SOURCES_MAX = 6;
const uniques = (xs: Array<RetrievedSource | null | undefined>): RetrievedSource[] => {
  const vus = new Set<string>();
  return xs.filter((x): x is RetrievedSource => !!x && !vus.has(x.id) && !!vus.add(x.id));
};

/** Sources ouvrables des coûts consolidés comptés dans un total (lot 45). */
function operationSources(q: QualifiedExpenses, assets: AssetRow[]): RetrievedSource[] {
  const comptees = new Set(q.byTheme.flatMap((t) => t.operationIds ?? []));
  const a = assets.length === 1 ? assets[0] : null;
  return uniques((q.operations?.lines ?? []).filter((l) => comptees.has(l.operationId))
    .map((l) => costLineSource(l, { assetId: a?.id ?? null, assetName: a?.name ?? null }))).slice(0, SOURCES_MAX);
}

/** Réponse « sinistre(s) » (pure, testée). */
export function claimAnswer(claims: ClaimOverview[], scope: ScopeLike, assets: AssetRow[]): CanonicalAnswer {
  const noms = new Map(assets.map((a) => [a.id, a.name]));
  const ligne = (c: ClaimOverview, detail: boolean) => {
    const biens = c.assetIds.map((id) => noms.get(id)).filter((n): n is string => !!n);
    const tete = `${c.label.charAt(0).toUpperCase()}${c.label.slice(1)}${c.occurredOn ? ` du ${formatDateFr(c.occurredOn)}` : ''}${biens.length && (!scope.label || biens.length > 1) ? ` (${joinFr(biens)})` : ''}`;
    const etat = [
      c.statusLabel ? `statut « ${c.statusLabel} »` : (c.closed ? 'clos' : 'statut non renseigné'),
      c.declaredOn ? `déclaré le ${formatDateFr(c.declaredOn)}` : null,
      detail && c.insurerClaimRef ? `référence assureur ${c.insurerClaimRef}` : null,
    ].filter(Boolean).join(', ');
    const montants = [
      c.indemnityCents != null ? `indemnité reçue : ${formatEur(c.indemnityCents)}` : (detail ? 'aucune indemnité enregistrée' : null),
      c.grossCents ? `coût des réparations : ${formatEur(c.grossCents)}` : null,
      c.grossCents && c.indemnityCents ? `net après indemnité : ${formatEur(c.netCents)}` : null,
    ].filter(Boolean).join(' ; ');
    return `${tete} : ${etat}${montants ? ` — ${montants}` : ''}`;
  };
  const answer = claims.length === 1
    ? `${ligne(claims[0], true)}.`
    : formatListBlocks(`Vous avez ${claims.length} sinistres${scope.label ? ` pour ${scope.label}` : ''}`, claims.map((c) => ligne(c, false)), 8);
  const scopeIds = new Set(scope.assets.map((a) => a.id));
  const sources: RetrievedSource[] = claims.slice(0, SOURCES_MAX).map((c): RetrievedSource | null => {
    const assetId = c.assetIds.find((id) => scopeIds.has(id)) ?? c.assetIds[0] ?? null;
    const content = ligne(c, true);
    return assetId
      ? { id: claimSourceId(assetId, c.operationId), type: 'asset_field', title: `${c.label.charAt(0).toUpperCase()}${c.label.slice(1)}`, content, relevanceScore: 1, meta: { assetId, assetName: noms.get(assetId) ?? null, date: c.occurredOn, agendaItemId: c.agendaItemId ?? null } }
      : c.documentIds[0]
        ? { id: `doc_${c.documentIds[0]}`, type: 'document', title: `Sinistre — ${c.label}`, content, relevanceScore: 1, meta: { fileId: c.documentIds[0], date: c.occurredOn } }
        : null;
  }).filter((x): x is RetrievedSource => !!x);
  return { strategy: 'structured.claim_status', answer, sources, claims: [claim('claims', answer, sources, 'direct')], kind: claims.length === 1 ? 'exact' : 'list' };
}

/** Réponse « coût d'une intervention précise » (pure, testée) — montant consolidé, provenance, parts à part. */
export function operationCostAnswer(couts: OperationCostRead[], scope: ScopeLike): CanonicalAnswer {
  const de = (lab: string) => (/^[aeiouéè]/i.test(lab) ? `de l’${lab}` : /^(sinistre|contrat|financement)\b/.test(lab) ? `du ${lab}` : `de la ${lab}`);
  const ligne = (c: OperationCostRead) => {
    const quand = [c.provider, c.date ? formatDateFr(c.date) : null].filter(Boolean).join(', ');
    const montant = c.costCents != null ? formatEur(c.costCents)
      : c.foreign.length ? `${c.foreign.map((f) => formatMinorAmount(f.amountMinor, f.currency)).join(' + ')} (non converti)`
        : 'montant non consolidé';
    const extras = [
      c.costCents != null && c.foreign.length ? `en plus, non converti : ${c.foreign.map((f) => formatMinorAmount(f.amountMinor, f.currency)).join(', ')}` : null,
      c.indemnityCents ? `indemnité reçue : ${formatEur(c.indemnityCents)}, net : ${formatEur((c.costCents ?? 0) - c.indemnityCents)}` : null,
      c.forecastCents ? `prévu (devis) : ${formatEur(c.forecastCents)}` : null,
      c.unattributedCents ? `part commune à plusieurs biens non répartie : ${formatEur(c.unattributedCents)}` : null,
    ].filter(Boolean);
    return { lab: `${c.label}${quand ? ` (${quand})` : ''}`, txt: `${montant}${extras.length ? ` — ${extras.join(' ; ')}` : ''}` };
  };
  const answer = couts.length === 1
    ? `Coût ${de(ligne(couts[0]).lab)} : ${ligne(couts[0]).txt}.`
    : formatListBlocks('Coûts correspondants', couts.map((c) => { const l = ligne(c); return `${l.lab.charAt(0).toUpperCase()}${l.lab.slice(1)} : ${l.txt}`; }), 5);
  const sources = uniques(couts.map((c) => c.source)).slice(0, SOURCES_MAX);
  const srcs = sources.length ? sources : scope.assets.map(assetSrc);
  return { strategy: 'structured.operation_cost', answer, sources: srcs, claims: [claim('operation_cost', answer, srcs, 'direct')], kind: couts.length === 1 ? 'exact' : 'list' };
}

/** Réponse « contrats » (pure, testée) : prestataire, n°, période, coûts documentés, tarif annoncé. */
export function contractsAnswer(contrats: ContractOverview[], scope: ScopeLike): CanonicalAnswer {
  const ligne = (c: ContractOverview) => [
    `${c.label.charAt(0).toUpperCase()}${c.label.slice(1)}`,
    c.provider ? ` chez ${c.provider}` : '',
    c.reference ? ` (n° ${c.reference})` : '',
    c.from && c.to ? `, du ${formatDateFr(c.from)} au ${formatDateFr(c.to)}` : c.from ? `, depuis le ${formatDateFr(c.from)}` : c.to ? `, jusqu’au ${formatDateFr(c.to)}` : '',
    c.status === 'ENVISAGED' ? ' — envisagé' : '',
    c.realizedCents != null ? ` — coûts documentés : ${formatEur(c.realizedCents)}` : '',
    c.forecastCents != null ? ` — tarif annoncé : ${formatEur(c.forecastCents)} (prévisionnel)` : '',
    // Lot 113AB (#725) : couvertures ÉTABLIES (justificatifs, corrections comprises) — même texte que les sources ; rien sinon.
    c.coverages?.length ? ` — ${coverageFactsText(c.coverages)}` : '',
  ].join('');
  const answer = contrats.length === 1
    ? `${ligne(contrats[0])}.`
    : formatListBlocks(`Contrats${scope.label ? ` de ${scope.label}` : ''}`, contrats.map(ligne), 8);
  // Lot 113AB : le document du contrat d'abord, puis les justificatifs des couvertures citées (consultables).
  const sources = uniques(contrats.flatMap((c) => [c.source, ...(c.coverageSources ?? [])])).slice(0, SOURCES_MAX);
  const srcs = sources.length ? sources : scope.assets.map(assetSrc);
  return { strategy: 'structured.contracts', answer, sources: srcs, claims: [claim('contracts', answer, srcs, 'direct')], kind: contrats.length === 1 ? 'exact' : 'list' };
}

/** Réponse « historique d'un bien » (pure, testée). */
export function historyAnswer(a: AssetRow, entries: AssetHistoryEntry[], theme: ExpenseTheme | null): CanonicalAnswer {
  const lignes = entries.map((e) => [
    `${e.date ? formatDateFr(e.date) : 'date non précisée'} : ${e.label}`,
    e.provider && e.kind === 'operation' ? ` (${e.provider})` : '',
    e.amountCents != null ? ` — ${formatEur(e.amountCents)}` : '',
    e.status ? ` — ${e.status}` : '',
  ].join(''));
  const titre = theme ? `${EXPENSE_THEME_LABELS[theme].charAt(0).toUpperCase()}${EXPENSE_THEME_LABELS[theme].slice(1)} de ${a.name}` : `Ce qui a été fait sur ${a.name}`;
  // Carte #790 (relance) : même texte qu'avant (annonce puis une ligne par entrée), écrit par le composeur commun.
  const answer = composeAnswerText([{ kind: 'list', intro: titre, items: lignes }]);
  const sources = uniques(entries.map((e) => e.source)).slice(0, 8);
  const srcs = sources.length ? sources : [assetSrc(a)];
  return { strategy: 'structured.operation_history', answer, sources: srcs, claims: [claim('history', answer, srcs, 'direct')], kind: 'list' };
}

/**
 * Lot 107C — point de départ cité par T2 : date d'achat du bien retenue par le
 * moteur TCO (`period.start`, `startKind`), jamais recalculée ; location, prêt,
 * don : début de la possession.
 */
function depuisAchat(t: import('@/services/business-operations/tco/model').TcoResult): string {
  if (!t.period.start) return '';
  return t.period.startKind === 'POSSESSION' ? `depuis le début de la possession le ${formatDateFr(t.period.start)}` : `depuis l’achat du bien le ${formatDateFr(t.period.start)}`;
}

/** Carte #790 (relance) — annonce des réserves d'un total de dépenses (texte à valider par le PO). */
export const EXPENSE_NOTES_INTRO = 'À noter';
/** Carte #790 (relance) — légende du chiffre principal du coût de possession (vocabulaire de la fiche). */
export const OWNERSHIP_COST_CAPTION = 'coût cumulé documenté';
/** Carte #790 (relance) — annonces des parties de la réponse « coût de possession » (textes à valider par le PO). */
export const OWNERSHIP_COST_SECTIONS = { breakdown: 'Ventilation', indicators: 'Autres indicateurs', limits: 'Limites' } as const;

/**
 * Lot 54D (§4.3) — réponse « coût de possession » : chiffres du service TCO
 * (moteur partagé), jamais recalculés ici. La source porte chaque montant cité
 * (vérifiable par `claim-support`) ; une couverture incomplète est dite.
 */
export function ownershipCostAnswer(a: AssetRow, t: import('@/services/business-operations/tco/model').TcoResult): CanonicalLevel1 {
  // ══════════════════════════════════════════════════════════════════════
  // CARTE #790, RELANCE DU 21/11/2026 (E03) — LA RÉPONSE DÉCLARE SA STRUCTURE
  //
  // Règle remplacée : toutes les phrases étaient assemblées sur une ligne
  // (`phrases.join(' ')`) — le rendu, qui découpe le TEXTE de la réponse, ne
  // recevait donc qu'un paragraphe dense. Les MÊMES faits (mêmes montants du
  // moteur TCO, mêmes phrases de réserve) sont désormais rangés en parties :
  //   1. le chiffre principal, seul : coût cumulé documenté ;
  //   2. la ventilation : un poste par ligne (et les avoirs, remboursements,
  //      indemnités déduits) ;
  //   3. les autres indicateurs chiffrés (moyenne annuelle, crédit, valeur) ;
  //   4. les limites : ce qui n'est pas calculé, pas compté, ou incomplet.
  // Aucun calcul n'est fait ici, aucun montant n'est ajouté ni retiré.
  // ══════════════════════════════════════════════════════════════════════
  const postes = t.breakdown.map((b) => `${b.label} : ${formatEur(b.costsCents)}`);
  if (t.reductionsCents) postes.push(`Avoirs : − ${formatEur(t.reductionsCents)}`);
  if (t.refundsCents) postes.push(`Remboursements : − ${formatEur(t.refundsCents)}`);
  if (t.indemnitiesCents) postes.push(`Indemnités : − ${formatEur(t.indemnitiesCents)}`);
  /** Indicateurs chiffrés, à part du chiffre principal (jamais additionnés à lui). */
  const indicateurs: string[] = [];
  /** Limites : ce qui n'est pas calculé, pas compté, ou possiblement incomplet. */
  const limites: string[] = [];
  // Point de départ (lot 107C) : dans la légende du chiffre principal s'il y tient, sinon en premier indicateur.
  const depuis = depuisAchat(t);
  const legendeCourte = `${OWNERSHIP_COST_CAPTION} de ${a.name}`;
  const legende = depuis && `${legendeCourte}, ${depuis}`.length <= METRIC_CAPTION_MAX ? `${legendeCourte}, ${depuis}` : legendeCourte;
  if (depuis && legende === legendeCourte) indicateurs.push(`Coût compté ${depuis}.`);
  // Lot 107C : même date de départ que la fiche (`period.start`, date d'achat du bien) ; contradiction sans autorité dite.
  if (t.period.startStatus === 'UNDETERMINED') limites.push('La date d’achat du bien est incertaine (plusieurs dates possibles se contredisent) : le coût moyen annuel n’est pas calculé.');
  // Lot 111F : mêmes définitions que la fiche (`t.indicators`, moteur TCO) — coût annuel moyen HORS prix d'achat,
  // coût du crédit selon l'échéancier, coût net seulement avec une estimation postérieure à l'achat.
  const ind = t.indicators;
  if (ind?.annualAverage.documentedCents != null) {
    indicateurs.push(`Coût annuel moyen de possession (hors prix d’achat du bien) : ${formatEur(ind.annualAverage.documentedCents)} par an.`);
  } else if (ind?.annualAverage.unavailableReason && t.period.startStatus !== 'UNDETERMINED') {
    limites.push(`Coût annuel moyen de possession non calculé : ${ind.annualAverage.unavailableReason.charAt(0).toLowerCase()}${ind.annualAverage.unavailableReason.slice(1)}`);
  }
  if (ind && ind.financing.loans.length && (ind.financing.costToDateCents || ind.financing.remainingCents)) {
    indicateurs.push(`Coût du crédit à date (intérêts, assurance, frais ; capital non compté) : ${formatEur(ind.financing.costToDateCents)}${ind.financing.basisLabel ? ` — ${ind.financing.basisLabel}` : ''}.`
      + (ind.financing.contractualTotalCents != null ? ` Coût total prévisionnel du crédit : ${formatEur(ind.financing.contractualTotalCents)}${ind.financing.estimated ? ' (échéancier partiel)' : ''}, non ajouté au coût total.` : ''));
  }
  // Lot 112D : capital restant dû — seulement s'il est établi (même résultat que la fiche), jamais un coût ni une estimation.
  const crd = ind?.financing.outstanding ?? null;
  if (ind && crd) {
    const prets = ind.financing.loans.filter((p) => p.outstanding);
    const quand = (d: string | null) => (d ? ` au ${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
    if (crd.status === 'ESTABLISHED' && crd.cents != null) {
      indicateurs.push(prets.length === 1
        ? `Capital restant dû${quand(prets[0].outstanding!.asOf)} : ${formatEur(crd.cents)} (${prets[0].outstanding!.label.replace(/\.$/, '')}) ; ce n’est pas un coût.`
        : `Capital restant dû des ${prets.length} prêts : ${formatEur(crd.cents)} ; ce n’est pas un coût.`);
    } else if (crd.status === 'PARTIAL') {
      indicateurs.push(`Capital restant dû établi pour une partie des prêts seulement : ${prets.filter((p) => p.outstanding!.status === 'ESTABLISHED').map((p) => `${p.label} ${formatEur(p.outstanding!.cents ?? 0)}${quand(p.outstanding!.asOf)}`).join(' ; ')}.`);
    } else {
      limites.push(prets.length === 1 ? prets[0].outstanding!.label : `Capital restant dû non établi pour les ${prets.length} prêts.`);
    }
  }
  if (t.disposed) {
    if (t.summary.netFinalCents != null) indicateurs.push(`Après la vente (prix réalisé ${formatEur(t.disposal.realizedPriceCents ?? 0)}), coût net final : ${formatEur(t.summary.netFinalCents)}.`);
    else limites.push('Le prix de cession réalisé n’est pas documenté : le coût net final n’est pas établi.');
  } else if (t.summary.currentValue && t.summary.netEstimatedCents != null) {
    indicateurs.push(`Valeur estimée ${formatEur(t.summary.currentValue.cents)} (estimation du ${formatDateFr(t.summary.currentValue.date)}) : coût net estimé ${formatEur(t.summary.netEstimatedCents)}.`);
  } else if (ind?.net.unavailableReason) {
    limites.push('Coût net estimé non calculé : aucune estimation de valeur admissible postérieure à l’achat (le prix d’achat n’est jamais une valeur actuelle).');
  }
  // Lot 108A (§C) : l'absence de valeur actuelle n'est pas une anomalie du TCO historique — aucune phrase d'alerte
  // (le coût net estimé est simplement « non calculable », la fiche l'affiche comme tel).
  if (t.reliability.unconverted.length) limites.push(`Non comptés (devise sans contre-valeur en euros) : ${t.reliability.unconverted.map((u) => formatMinorAmount(u.amountMinor, u.currency)).join(', ')}.`);
  if (t.reliability.unallocated.count) limites.push('Des montants communs à plusieurs biens ne sont pas ventilés et ne sont pas comptés.');
  if (t.status !== 'COMPLETE') limites.push(t.status === 'PARTIAL' ? 'Résultat partiel.' : 'Ce total peut être incomplet.');
  // Lot 108C (TCO-646 §E) : le coût documenté (dépenses réelles) reste annoncé tel quel ; le TCO complet estimé
  // l'ajoute au complément des dépenses d'usage (forfaits, périodes écoulées), en annonçant la part estimée.
  const estime = t.summary.estimatedUsageComplementCents ?? 0;
  if (estime > 0) {
    indicateurs.push(`En incluant les estimations de dépenses d’usage (${formatEur(estime)} estimés à partir de vos forfaits, pour les périodes écoulées sans justificatif suffisant), le coût total de possession estimé est de ${formatEur(t.summary.totalWithEstimatesCents)}.`);
  }
  if (t.usage.annualEstimateCents) indicateurs.push(`Forfaits d’usage en cours : ${formatEur(t.usage.annualEstimateCents)} par an (prévisionnel, jamais ajouté pour les mois à venir).`);
  const parts: AnswerPart[] = [
    { kind: 'metric', value: formatEur(t.summary.cumulativeCostCents), caption: legende },
    { kind: 'list', intro: OWNERSHIP_COST_SECTIONS.breakdown, items: postes },
    { kind: 'list', intro: OWNERSHIP_COST_SECTIONS.indicators, items: indicateurs },
    { kind: 'list', intro: OWNERSHIP_COST_SECTIONS.limits, items: limites },
  ];
  const answer = composeAnswerText(parts.filter((p) => p.kind !== 'list' || p.items.length > 0));
  const src: RetrievedSource = {
    id: `tco:${a.id}`, type: 'document_extraction', title: `Coût de possession — ${a.name}`, content: answer.slice(0, 1500), relevanceScore: 1,
    meta: {
      assetId: a.id, assetName: a.name, cumulativeCostCents: t.summary.cumulativeCostCents, netEstimatedCents: t.summary.netEstimatedCents,
      // Lot 108C : part estimée et TCO complet estimé (le coût documenté reste strictement réel).
      estimatedUsageComplementCents: t.summary.estimatedUsageComplementCents ?? 0, totalWithEstimatesCents: t.summary.totalWithEstimatesCents ?? t.summary.cumulativeCostCents,
      netFinalCents: t.summary.netFinalCents, status: t.status, operationCount: t.reliability.operationsCounted,
      // Lot 111F : coût annuel moyen hors prix d'achat et coût du crédit à date (mêmes valeurs que la fiche).
      annualAverageCents: t.indicators?.annualAverage.documentedCents ?? null, financingToDateCents: t.indicators?.financing.costToDateCents ?? 0,
      // Lot 61 : justificatifs comptés directement (sans Opération) — même calcul que le tiroir.
      documentCount: t.reliability.documentsCounted ?? 0,
      includedDocuments: t.reliability.documents.slice(0, 50).map((d) => `doc-${d.fileId}`).join(' '),
    },
  };
  const sources = [src];
  return { strategy: 'structured.ownership_cost', answer, sources, claims: [claim('ownership_cost', answer, sources, 'calculated')], kind: 'exact' };
}

/**
 * Lot 112C (reprise) — coût de possession HORS OFFRE (Standard, lecture seule) :
 * même message que la fiche (`TCO_PREMIUM_MESSAGE`), aucun montant ; les
 * dépenses documentées restent ouvertes à tous (pure, testée).
 */
export function ownershipCostLockedAnswer(a: Pick<AssetRow, 'id' | 'name'> | null): CanonicalLevel1 {
  const pour = a ? `Pour ${a.name}, vous pouvez consulter vos dépenses documentées, par exemple : « Combien ai-je dépensé en entretien pour ${a.name} ? ».`
    : 'Vos dépenses documentées restent consultables, par bien et par thème (entretien, réparations, travaux…).';
  // Carte #790 (relance) : le message de l'offre, puis ce qui reste consultable — deux paragraphes distincts.
  const answer = composeAnswerText([{ kind: 'paragraph', text: TCO_PREMIUM_MESSAGE }, { kind: 'paragraph', text: pour }]);
  const src: RetrievedSource = {
    id: 'product_rule:tco_premium', type: 'product_rule', title: 'Coût de possession — offres Premium', content: TCO_PREMIUM_MESSAGE, relevanceScore: 1,
    meta: { ruleCode: 'tco_premium', locked: true, ...(a ? { assetId: a.id } : {}) },
  };
  return { strategy: 'structured.ownership_cost', answer, sources: [src], claims: [claim('ownership_cost_locked', answer, [src], 'direct')], kind: 'no_result' };
}

/**
 * C15.2 — prix d'achat comme interprétation principale ; le cumul des
 * dépenses depuis l'achat présenté À PART, jamais additionné. `null` : aucun
 * prix d'achat connu (consolidé ni sur la fiche).
 */
async function acquisitionAnswer(port: AccountDataPort, accountId: number, a: AssetRow, achatSeul: boolean): Promise<CanonicalLevel1> {
  const acq = await port.readAcquisition!(accountId, a.id, { assetName: a.name });
  let prix: string | null = acq?.priceCents != null ? formatEur(acq.priceCents)
    : acq?.foreign.length ? acq.foreign.map((f) => formatMinorAmount(f.amountMinor, f.currency)).join(' + ') : null;
  let src: RetrievedSource | null = acq?.source ?? null;
  if (!prix && port.readAssetField) {
    const r = await port.readAssetField(accountId, a.id, 'acquisitionPrice').catch(() => null);
    if (r && r.value !== null && r.value !== undefined && r.display) { prix = r.display; src = assetFieldSource(r); }
  }
  if (!prix) return null;
  const sources = uniques([src ?? assetSrc(a)]);
  // Carte #790 (relance du 21/11/2026) : le prix d'abord, seul ; les écarts et frais annexes, puis le cumul des
  // dépenses depuis l'achat, chacun dans son paragraphe (mêmes phrases qu'avant, plus jamais sur une seule ligne).
  const parts: AnswerPart[] = [
    { kind: 'paragraph', text: `Prix d’achat de ${a.name} : ${prix}${acq?.date ? ` (achat du ${formatDateFr(acq.date)})` : ''}.` },
    ...acquisitionSideNoteLines(acq).map((text): AnswerPart => ({ kind: 'paragraph', text })),
  ];
  if (!achatSeul && port.sumQualifiedExpenses) {
    const q = await port.sumQualifiedExpenses(accountId, { assetIds: [a.id], theme: null });
    const hors = q.byTheme.filter((t) => t.theme !== 'purchase' && t.sumCents);
    const somme = hors.reduce((n, t) => n + t.sumCents, 0);
    if (hors.length && somme) {
      parts.push({ kind: 'paragraph', text: `Si vous parlez des dépenses depuis l’achat (hors prix d’achat) : ${formatEur(somme)} (${hors.map((t) => `${t.label} ${formatEur(t.sumCents)}`).join(', ')})${q.complete ? '' : ', total peut-être incomplet'}. Ces deux montants ne s’additionnent pas sans que vous le demandiez.` });
      sources.push(expenseSumSource(q, { assetIds: [a.id], scopeLabel: a.name }));
    }
  }
  const answer = composeAnswerText(parts);
  return { strategy: 'structured.acquisition_price', answer, sources, claims: [claim('acquisition', answer, sources, 'direct')], kind: 'exact' };
}

/**
 * Lot 53D (retour PO D9) — écarts et frais annexes de l'achat (pure, testée) :
 * la valeur saisie reste la référence, l'écart avec un document est dit (pas
 * effacé), les frais connus sont cités à part, jamais additionnés.
 */
export function acquisitionSideNotes(acq: Pick<import('./operations').AcquisitionRead, 'priceCents' | 'documentPrices' | 'fees'> | null | undefined): string {
  const out = acquisitionSideNoteLines(acq);
  return out.length ? ` ${out.join(' ')}` : '';
}

/** Carte #790 (relance) — les mêmes notes, une par élément (chacune devient un paragraphe de la réponse). */
export function acquisitionSideNoteLines(acq: Pick<import('./operations').AcquisitionRead, 'priceCents' | 'documentPrices' | 'fees'> | null | undefined): string[] {
  if (!acq) return [];
  const out: string[] = [];
  const titre = (t: string | null) => (t ? ` « ${t.slice(0, 60)} »` : '');
  for (const d of (acq.documentPrices ?? []).slice(0, 2)) {
    out.push(`Le document${titre(d.title)} indique ${formatMinorAmount(d.amountMinor, d.currency)} : la valeur saisie sur la fiche est conservée comme référence.`);
  }
  const fees = acq.fees ?? [];
  if (fees.length) {
    out.push(`Frais annexes connus, non inclus dans ce prix : ${fees.slice(0, 3).map((f) => `${formatMinorAmount(f.amountMinor, f.currency)}${titre(f.title)}`).join(', ')}.`);
  }
  return out;
}

/** Réponse « payé / réglé » (pure, testée) — preuves de règlement, jamais le coût présenté comme réglé. */
export function paymentsAnswer(
  pay: PaymentsRead,
  q: QualifiedExpenses | null,
  ctx: { pour: string; scopeLabel: string | null; assetIds: number[]; year?: number; assets: AssetRow[] },
): CanonicalAnswer {
  const pl = (n: number, a: string, b: string) => (n > 1 ? b : a);
  const cout = q && q.qualifiedSumCents ? q.qualifiedSumCents : 0;
  const costSrc = q && cout ? expenseSumSource(q, { assetIds: ctx.assetIds, scopeLabel: ctx.scopeLabel, year: ctx.year }) : null;
  // Carte #790 (relance) : ce qui est justifié, puis ce qui est documenté — deux paragraphes (mêmes phrases).
  const regle: string[] = [];
  const documente: string[] = [];
  let kind: 'calc' | 'no_result' = 'calc';
  const docs: RetrievedSource[] = pay.proofs.slice(0, SOURCES_MAX).map((p) => ({
    id: `doc_${p.fileId}`, type: 'document', title: p.title,
    content: `Preuve de paiement « ${p.title} »${p.date ? ` · ${p.date}` : ''}${p.amountCents != null ? ` · montant réglé : ${formatEur(p.amountCents)}` : ' · montant non lisible'}`,
    relevanceScore: 1, meta: { fileId: p.fileId, date: p.date },
  }));
  if (pay.proofs.length) {
    const n = pay.proofs.length;
    regle.push(`Règlements justifiés${ctx.pour} : ${formatEur(pay.sumCents)} (${n} preuve${pl(n, '', 's')} de paiement : ${joinFr(pay.proofs.slice(0, 4).map((p) => `« ${p.title} »`))}${n > 4 ? '…' : ''}).`);
    if (pay.withoutAmount) regle.push(`${pay.withoutAmount} preuve${pl(pay.withoutAmount, '', 's')} sans montant lisible.`);
    if (cout) {
      documente.push(`Coût documenté${ctx.pour} : ${formatEur(cout)}${q!.complete ? '' : ' (total peut-être incomplet)'}.`);
      if (cout > pay.sumCents) documente.push(`Je n’ai pas de preuve de règlement pour ${formatEur(cout - pay.sumCents)}.`);
    }
  } else {
    regle.push(`Je n’ai trouvé aucune preuve de paiement${ctx.pour} : je ne peux pas confirmer ce qui a été réglé.`);
    if (cout) documente.push(`Le coût documenté${ctx.pour} est de ${formatEur(cout)} : ce montant ne prouve pas qu’il a été réglé.`);
    else kind = 'no_result';
  }
  const answer = composeAnswerText([{ kind: 'paragraph', text: regle.join(' ') }, { kind: 'paragraph', text: documente.join(' ') }]);
  const sources = uniques([...docs, costSrc, ...(docs.length || costSrc ? [] : ctx.assets.map(assetSrc))]);
  return { strategy: 'structured.payments', answer, sources, claims: [claim('payments', answer, sources, 'calculated')], kind };
}

/**
 * Réponse canonique structurée, ou `null` (les branches historiques
 * s'appliquent ensuite). `resolveScope(texte)` : résolution du bien de
 * `data-answer` (clarification, page, mots du message).
 */
// ══════════════════════════════════════════════════════════════════════════
// LOT 54E (#419 écart 7) — BARRIÈRE SÉMANTIQUE TRANSVERSALE
//
// Avant qu'une réponse STRUCTURÉE ne soit servie, une barrière UNIQUE
// vérifie que la stratégie candidate CONSOMME tout le sens de la question :
//
//   strategyCandidate + semanticScopeResolved + unresolvedSemanticTerms
//
//   résolu      → la réponse est servie ;
//   non résolu  → aucune stratégie plus large : `scopeUnresolved` (T2
//                 UNDERSTAND, sources réelles, clarification ou insuffisant).
//
// Chaque stratégie DÉCLARE ici sa portée (type exhaustif : une stratégie
// ajoutée sans déclaration ne compile pas) :
//   · `structural` — le périmètre est entièrement fixé par une donnée
//     structurée (clé du registre, liste explicite, opération désignée par
//     son libellé réel) : rien ne peut être élargi ;
//   · `semantic`   — agrégat ou lecture large : tout terme significatif non
//     consommé par son vocabulaire bloque la réponse.
// Les gardes historiques par stratégie (lot 49) restent en place ; la
// barrière est le filet commun, y compris pour les stratégies futures.
// ══════════════════════════════════════════════════════════════════════════
// Lot 59 (#419 R06) : une stratégie `structural` n'est plus réputée résolue
// par principe. Seule la lecture d'un CHAMP DU REGISTRE l'est (sa phrase
// désigne exactement la clé lue, consommée par `findReadableFields`) ; les
// autres sont `designated` : leur périmètre est démontré par les DONNÉES
// servies (titres des éléments lus) — un sujet significatif que ni leur
// vocabulaire ni ces données ne consomment bloque la réponse (T2 reprend).
export const STRATEGY_SCOPE: Readonly<Record<CanonicalStrategy, { scope: 'structural' | 'designated' | 'semantic'; vocabulary: RegExp | null }>> = {
  'structured.asset_field': { scope: 'structural', vocabulary: null },
  'structured.upcoming_agenda': { scope: 'designated', vocabulary: /[ée]ch[ée]ances?|rendez-vous|[ée]v[ée]nements?|rappels?|bient[ôo]t|arrivent|prochaine?s?|[àa] venir|agenda|quel(le)?s?/gi },
  'structured.missing_information': { scope: 'designated', vocabulary: /informations?|manqu\w*|incompl\w*|compl[eé]ter|renseign\w*|fiches?|quel(le)?s?/gi },
  'structured.operation_cost': { scope: 'designated', vocabulary: /d[ée]pens\w*|co[uû]t\w*|pay\w*|total|somme|montant|combien|prix|r[ée]parations?|entretiens?|travaux|interventions?|r[ée]visions?/gi },
  'structured.sum_qualified': { scope: 'semantic', vocabulary: /d[ée]pens\w*|co[uû]t\w*|pay\w*|total|somme|montant|combien|nombre|ai-je|j['’]ai/gi },
  'structured.payments': { scope: 'semantic', vocabulary: PAID_STRIP_SOURCE() },
  'structured.acquisition_price': { scope: 'semantic', vocabulary: PAID_STRIP_SOURCE() },
  'structured.contracts': { scope: 'semantic', vocabulary: /contrats?|polices?|assurances?|abonnements?|en cours|souscrits?|aupr[eè]s de qui|chez qui|quel(le)?s?/gi },
  'structured.operation_history': { scope: 'semantic', vocabulary: /qu['’]?est-ce qu['’]?(il|on) a [ée]t[ée] fait|qu['’]?est-ce qui a [ée]t[ée] (fait|r[ée]alis[ée])|ce qui a [ée]t[ée] (fait|r[ée]alis[ée])|que s['’]?est-il pass[ée]|qu['’]?a-t-on fait|historique|interventions?|r[ée]parations?|travaux|entretiens?|op[ée]rations?|r[ée]alis[ée]e?s?|faite?s?|effectu[ée]e?s?|quel(le)?s?/gi },
  'structured.claim_status': { scope: 'semantic', vocabulary: /sinistres?|o[uù] en (est|sont)|statut|[ée]tat|avancement|indemni\w*|rembours\w*|dossiers?|suivi|d[ée]clar\w*|expert\w*/gi },
  'structured.ownership_cost': { scope: 'semantic', vocabulary: /co[uû]ts? (total|totaux|global|globaux|complet|r[ée]el) de (possession|d[ée]tention)|co[uû]ts? de (possession|d[ée]tention)|tco|co[uû]t total|co[uû]t global|au total|combien|m['’]?a|co[uû]t[ée]?|poss[ée]der|avoir|d[ée]tention|possession/gi },
};

/** Vocabulaire « payé / réglé » (même motif que la stratégie). */
function PAID_STRIP_SOURCE(): RegExp {
  return /pay[ée]e?s?|payer|r[ée]gl[ée]e?s?|r[ée]gler|acquitt[ée]e?s?|vers[ée]e?s?|combien|ai-je|j['’]ai|deja|déjà|a-t-(il|elle)|est-(il|elle)|[ée]t[ée]|prix|achat|achet[ée]e?/gi;
}

/**
 * Barrière (pure, testée) : termes significatifs de la question que la
 * stratégie candidate ne consomme pas. `[]` : périmètre résolu.
 */
export function structuredScopeBarrier(
  strategy: CanonicalStrategy, message: string, assetNames: readonly string[], served: readonly string[] = [],
  /** Lot 75J : formulations réellement consommées par la stratégie (phrase du champ lu). */
  consumedPhrases: readonly string[] = [],
): { semanticScopeResolved: boolean; unresolvedSemanticTerms: string[] } {
  const d = STRATEGY_SCOPE[strategy];
  // Lot 75J (#419 R06) : une stratégie `structural` n'est plus réputée résolue par sa seule
  // catégorie. Sa phrase du registre (consommée par `findReadableFields`) et la donnée servie
  // (libellé du champ, bien) consomment le sujet ; tout AUTRE sujet significatif la bloque.
  const parDonnees = d.scope === 'designated' || d.scope === 'structural';
  const consumed = [...expenseThemeWords(message), ...MOTS_DEPENSE, ...Object.values(EXPENSE_THEME_LABELS), ...(d.vocabulary ? message.match(d.vocabulary) ?? [] : []),
    // Stratégie DÉSIGNÉE : les données réellement servies consomment le sujet qu'elles portent.
    ...(parDonnees ? served : []), ...consumedPhrases];
  // Même correspondance que la lecture des données (« toit » → « toiture »).
  const servi = parDonnees ? served.join(' ') : '';
  const terms = semanticResidue(message, { assetNames, consumed }).filter((t) => !servi || !textMatchesTerms(servi, [t]));
  return { semanticScopeResolved: terms.length === 0, unresolvedSemanticTerms: terms };
}

/** Stratégies qui additionnent des montants sur les biens du périmètre. */
const AGGREGATING: ReadonlySet<CanonicalStrategy> = new Set<CanonicalStrategy>(['structured.sum_qualified', 'structured.payments']);

/**
 * Réponse canonique structurée, ou `null` — toute réponse passe par la
 * barrière sémantique transversale (lot 54E) avant d'être servie.
 */
export async function tryCanonicalStructured(p: {
  port: AccountDataPort;
  accountId: number;
  message: string;
  resolveScope: (text: string) => Promise<ScopeLike>;
}): Promise<CanonicalLevel1> {
  let dernier: ScopeLike | null = null;
  const r = await tryCanonicalStructuredInner({ ...p, resolveScope: async (t) => (dernier = await p.resolveScope(t)) });
  if (!r || !('strategy' in r)) return r;
  // Carte #880 : un DIAGNOSTIC (cible introuvable, indisponible, lecture en erreur) ne sert aucune valeur —
  // la barrière, qui empêche de servir une donnée hors sujet, ne s'y applique pas (sinon « Maisonnette »
  // introuvable redevenait un périmètre non résolu, puis une recherche documentaire vide).
  if (r.diagnostic) return r;
  // Lot 114A (#753, CDC T2 §11.1) — garde transversale : aucune stratégie de
  // totalisation ne sert un agrégat sur des biens concurrents d'une demande
  // au singulier, quelle que soit la branche qui l'a produit.
  const portee = dernier as ScopeLike | null;
  if (portee && AGGREGATING.has(r.strategy) && !aggregateAllowed(portee)) {
    return { ambiguous: portee.assets, reason: 'AGGREGATE_MULTIPLE_ASSETS' };
  }
  const assets = (dernier as ScopeLike | null)?.assets ?? [];
  const champ = r.strategy === 'structured.asset_field' ? (findReadableField(p.message) ?? purchaseQuestion(p.message)) : null;
  const b = structuredScopeBarrier(r.strategy, p.message, assets.map((a) => a.name), [r.answer, ...r.sources.map((x) => x.title ?? '')], champ ? [champ.phrase] : []);
  if (b.semanticScopeResolved) return r;
  return { scopeUnresolved: { strategyCandidate: r.strategy, terms: b.unresolvedSemanticTerms, assetIds: assets.map((a) => a.id) } };
}

async function tryCanonicalStructuredInner(p: {
  port: AccountDataPort;
  accountId: number;
  message: string;
  resolveScope: (text: string) => Promise<ScopeLike>;
}): Promise<CanonicalLevel1> {
  const { port, accountId, message } = p;
  const m = plain(message);
  const today = port.today();
  // Carte #880 (R01) : noms des biens du compte, lus au plus une fois — un mot d'un NOM (« Ferme du Suivi »)
  // n'est jamais retiré, même s'il est aussi un mot de la question (« suivi »).
  let nomsDuCompte: Promise<string[]> | null = null;
  const noms = () => (nomsDuCompte ??= Promise.resolve(port.listAssets ? port.listAssets(accountId) : []).then((l) => (l ?? []).map((a) => a.name)).catch(() => []));
  const sansMotsDeQuestion = async (texte: string, re: RegExp) => stripOutsideNames(texte, re, await noms());
  /** Résidu sémantique d'une stratégie candidate (lot 49) : ce qu'elle ne consomme pas. */
  const residu = (scope: ScopeLike, consumed: readonly string[] = []) =>
    semanticResidue(message, { assetNames: scope.assets.map((a) => a.name), consumed: [...expenseThemeWords(message), ...MOTS_DEPENSE, ...consumed] });
  const nonResolu = (strategyCandidate: CanonicalStrategy, terms: string[], scope: ScopeLike): ScopeUnresolved =>
    ({ scopeUnresolved: { strategyCandidate, terms, assetIds: scope.assets.map((a) => a.id) } });
  /**
   * Lot 75J (#419 R06) — barrière évaluée AVANT la lecture d'une stratégie à
   * portée `semantic` (son verdict ne dépend pas des données servies) : un
   * sujet significatif non consommé renvoie à T2 sans lecture ni calcul
   * évitable. Même verdict que la barrière finale.
   */
  const avantLecture = (strategy: CanonicalStrategy, scope: ScopeLike): ScopeUnresolved | null => {
    if (STRATEGY_SCOPE[strategy].scope !== 'semantic') return null;
    const b = structuredScopeBarrier(strategy, message, scope.assets.map((a) => a.name));
    return b.semanticScopeResolved ? null : nonResolu(strategy, b.unresolvedSemanticTerms, scope);
  };

  // ── Informations manquantes (T2-04) ────────────────────────────────────
  if (MISSING.test(m) && port.listMissingInformation) {
    const reste = await sansMotsDeQuestion(message, MISSING_STRIP);
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'MISSING_INFO_MULTIPLE_ASSETS' };
    if (scope.unresolved) return null;
    const list = await port.listMissingInformation(accountId, { assetIds: scope.assets.map((a) => a.id) });
    const lignes = list.filter((a) => a.missing.length || a.toProcess.length).map((a) => {
      const parts = [
        a.missing.length ? `à renseigner : ${joinFr(a.missing.map((x) => x.label.toLowerCase()))}` : null,
        a.toProcess.length ? `${a.toProcess.length} élément${a.toProcess.length > 1 ? 's' : ''} à traiter` : null,
      ].filter(Boolean);
      return `${a.assetName} — ${parts.join(' ; ')}`;
    });
    const sources: RetrievedSource[] = list.flatMap((a) => a.missing.slice(0, 4).map((x) => ({
      id: assetFieldSourceId(a.assetId, x.key), type: 'asset_field' as const, title: `${x.label} — ${a.assetName}`,
      content: `${x.label} : non renseigné (information attendue pour ce bien)`, relevanceScore: 1,
      meta: { assetId: a.assetId, fieldKey: x.key, value: null, missing: true },
    }))).slice(0, 8);
    const answer = lignes.length === 0
      ? formatNoResult('aucune information manquante', scope.label ? `sur la fiche de ${scope.label}` : 'sur vos fiches')
      : formatListBlocks(scope.label ? `Informations à compléter pour ${scope.label}` : 'Informations à compléter', lignes, 10);
    const srcs = sources.length ? sources : scope.assets.map(assetSrc);
    return { strategy: 'structured.missing_information', answer, sources: srcs, claims: [claim('missing', answer, srcs, 'calculated')], kind: lignes.length ? 'list' : 'no_result' };
  }

  // ══════════════════════════════════════════════════════════════════════
  // LOT 45 (O6) — OPÉRATION D'ABORD, NON EXCLUSIVE (CDC Opérations V1 C15)
  //
  // Sinistre, historique d'un bien, « payé / réglé », prix d'achat : lus
  // d'abord sur les Opérations actives (montants consolidés par T3, jamais
  // recalculés). Aucune Opération pour la question : `null`, les branches
  // historiques répondent comme avant (16.2). Vocabulaire P09.
  // ══════════════════════════════════════════════════════════════════════

  // ── Lot 54D (§4.3) : coût de possession d'un bien → service TCO ─────────
  // ══════════════════════════════════════════════════════════════════════
  // CARTE #880 (E01, E02, R01, R02) — LE BESOIN TCO EST CONSERVÉ JUSQU'À LA
  // RÉPONSE
  //
  // Règle remplacée : le nom du bien était résolu sur un texte ALTÉRÉ
  // (« ison ? » pour « Maison ») et tout ce qui n'était pas « un bien trouvé +
  // TCO lu » (cible introuvable, erreur de lecture avalée par
  // `catch(() => null)`) laissait la cascade continuer jusqu'à la recherche
  // documentaire vide — « Je n'ai rien trouvé ».
  //
  // Désormais (mots ENTIERS retirés, texte du nom intact) :
  //   · bien unique + droit : le moteur TCO partagé avec la fiche (mêmes
  //     montants, ventilation, limites), seul ;
  //   · hors offre : message Premium / Premium Duo, AUCUN montant (inchangé) ;
  //   · plusieurs biens : clarification ;
  //   · question EXPLICITE sans bien désigné : le bien unique du compte, sinon
  //     clarification parmi les biens ;
  //   · question EXPLICITE, désignation introuvable : « bien non identifié » ;
  //   · bien supprimé / inaccessible : « plus disponible » ;
  //   · erreur de lecture : « lecture impossible » (jamais « aucune donnée ») ;
  //   chacun tracé (`reading`, `diagnostic`). Les formes LARGES (« combien
  //   m'a coûté … au total ») gardent leur parcours (barrière #419,
  //   compréhension) quand la cible n'est pas résolue.
  // ══════════════════════════════════════════════════════════════════════
  if (isOwnershipCostQuestion(message) && port.readOwnershipCost) {
    const explicite = isExplicitOwnershipCostQuestion(message);
    const reste = await sansMotsDeQuestion(message, TCO_STRIP);
    const scope = await p.resolveScope(reste);
    const lecture = (o: Partial<BusinessReadingTrace> & Pick<BusinessReadingTrace, 'outcome'>): BusinessReadingTrace => ({
      reading: 'OWNERSHIP_COST', strategyCandidate: 'structured.ownership_cost', strategyExecuted: null,
      phrasing: explicite ? 'EXPLICIT' : 'BROAD', assetResolution: 'NONE', assetId: null, aiCall: 'NOT_NEEDED_DETERMINISTIC', ...o,
    });
    const resolution = (): BusinessReadingTrace['assetResolution'] => scope.resolvedBy ?? 'NAME';
    // Lot 112C (reprise) — DROITS : le TCO est réservé Premium / Premium Duo / essai (même règle que la
    // fiche). Hors offre : réponse sans AUCUN montant, avant toute lecture TCO et sans clarification de
    // bien ; une question qui n'est pas un coût de possession (barrière) reste traitée comme avant.
    if (port.ownershipCostAllowed && !(await port.ownershipCostAllowed(accountId))) {
      const b = structuredScopeBarrier('structured.ownership_cost', message, scope.assets.map((a) => a.name));
      if (!b.semanticScopeResolved && !explicite) return nonResolu('structured.ownership_cost', b.unresolvedSemanticTerms, scope);
      const cible = scope.assets.length === 1 && !scope.ambiguous ? scope.assets[0] : null;
      return { ...ownershipCostLockedAnswer(cible) as CanonicalAnswer, reading: lecture({ outcome: 'LOCKED', strategyExecuted: 'structured.ownership_cost', assetResolution: cible ? resolution() : 'NONE', assetId: cible?.id ?? null }) };
    }
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'TCO_MULTIPLE_ASSETS', reading: lecture({ outcome: 'CLARIFICATION', assetResolution: 'AMBIGUOUS' }) };
    let cible: AssetRow | null = !scope.unresolved && scope.assets.length === 1 ? scope.assets[0] : null;
    let par: BusinessReadingTrace['assetResolution'] = cible ? resolution() : 'NONE';
    if (!cible && explicite) {
      const biens = await port.listAssets(accountId).catch(() => null);
      if (!biens) {
        const answer = diagnosticMessage('TECHNICAL_READ_FAILURE');
        return { strategy: 'structured.ownership_cost', answer, sources: [], claims: [claim('ownership_cost_unavailable', answer, [], 'direct')], kind: 'no_result', diagnostic: 'TECHNICAL_READ_FAILURE', reading: lecture({ outcome: 'READ_ERROR', assetResolution: scope.unresolved ? 'NOT_FOUND' : 'NONE' }) };
      }
      if (scope.unresolved) {
        // Désignation introuvable : diagnostic explicite (texte original, jamais tronqué), aucune recherche.
        const designation = designationOf(reste);
        const answer = [diagnosticMessage('TARGET_NOT_FOUND', { kind: 'asset', designation }),
          biens.length ? `Vos biens : ${joinFr(biens.slice(0, 8).map((x) => x.name))}${biens.length > 8 ? '…' : ''}.` : null].filter(Boolean).join(' ');
        const srcs = biens.slice(0, 8).map(assetSrc);
        return { strategy: 'structured.ownership_cost', answer, sources: srcs, claims: [claim('ownership_cost_target', answer, srcs, 'direct')], kind: 'no_result', diagnostic: 'TARGET_NOT_FOUND', reading: lecture({ outcome: 'TARGET_NOT_FOUND', assetResolution: 'NOT_FOUND' }) };
      }
      if (biens.length > 1) return { ambiguous: biens.slice(0, 12), reason: 'TCO_ASSET_REQUIRED', reading: lecture({ outcome: 'CLARIFICATION', assetResolution: 'AMBIGUOUS' }) };
      if (biens.length === 1) { cible = biens[0]; par = 'SINGLE_ASSET'; }
      else {
        const answer = 'Aucun bien actif n’est enregistré dans votre compte : le coût de possession se calcule pour un bien. Ajoutez un bien pour le suivre.';
        return { strategy: 'structured.ownership_cost', answer, sources: [], claims: [claim('ownership_cost_target', answer, [], 'direct')], kind: 'no_result', diagnostic: 'TARGET_NOT_FOUND', reading: lecture({ outcome: 'NO_ASSET' }) };
      }
    }
    if (cible) {
      const a = cible;
      // Lot 54E (#419 écart 7) : barrière transversale AVANT exécution —
      // « combien m'a coûté internet au total ? » n'est pas le coût du bien.
      const b = structuredScopeBarrier('structured.ownership_cost', message, [a.name]);
      if (!b.semanticScopeResolved) return nonResolu('structured.ownership_cost', b.unresolvedSemanticTerms, scope);
      const lu = await port.readOwnershipCost(accountId, a.id).then((t) => ({ t }), (e: unknown) => ({ e }));
      if ('t' in lu && lu.t) {
        return { ...ownershipCostAnswer(a, lu.t) as CanonicalAnswer, reading: lecture({ outcome: 'ANSWERED', strategyExecuted: 'structured.ownership_cost', assetResolution: par, assetId: a.id }) };
      }
      // Bien devenu indisponible (supprimé, autre compte) ou lecture en erreur : états DISTINCTS, dits tels quels.
      const indisponible = 'e' in lu && (lu.e as Error | undefined)?.name === 'AssetNotFoundForTcoError';
      if ('e' in lu) console.error('[verebona] lecture TCO impossible', { accountId, assetId: a.id, error: (lu.e as Error | undefined)?.name ?? String(lu.e) });
      const diagnostic: T2Diagnostic = indisponible ? 'TARGET_UNAVAILABLE' : 'TECHNICAL_READ_FAILURE';
      const answer = indisponible ? diagnosticMessage('TARGET_UNAVAILABLE')
        : `${diagnosticMessage('TECHNICAL_READ_FAILURE')} Le coût de possession de ${a.name} reste consultable depuis sa fiche.`;
      const srcs = indisponible ? [] : [assetSrc(a)];
      return { strategy: 'structured.ownership_cost', answer, sources: srcs, claims: [claim('ownership_cost_unavailable', answer, srcs, 'direct')], kind: 'no_result', diagnostic, reading: lecture({ outcome: indisponible ? 'TARGET_UNAVAILABLE' : 'READ_ERROR', strategyExecuted: 'structured.ownership_cost', assetResolution: par, assetId: a.id }) };
    }
  }

  // ── Sinistres : « où en est mon sinistre ? », indemnité ───────────────
  if (CLAIM_Q.test(m) && CLAIM_ASK.test(m) && !/\bcomment\b/.test(m) && port.readClaims) {
    const reste = await sansMotsDeQuestion(message, CLAIM_STRIP);
    const scope = await p.resolveScope(reste);
    if (!scope.unresolved) {
      const pre = avantLecture('structured.claim_status', scope);
      if (pre) return pre;
      const tous = await port.readClaims(accountId, scope.assets.map((a) => a.id));
      // Lot 49 : un sinistre PRÉCIS (« le dégât des eaux ») est cherché dans
      // le texte des sinistres réels ; rien ne répond → T2, jamais la liste.
      const termes = tous.length ? residu(scope, message.match(CLAIM_STRIP) ?? []) : [];
      const claims = termes.length ? tous.filter((c) => textMatchesTerms(c.label, termes)) : tous;
      if (termes.length && !claims.length) return nonResolu('structured.claim_status', termes, scope);
      if (claims.length) return claimAnswer(claims, scope, scope.assets.length ? scope.assets : await port.listAssets(accountId).catch(() => []));
    }
  }

  // ── Historique d'un bien : « qu'est-ce qui a été fait sur la Polo ? » ──
  if (HISTORY_Q.test(m) && !HISTORY_NOT.test(m) && port.readAssetHistory) {
    const reste = await sansMotsDeQuestion(message, HISTORY_STRIP);
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'HISTORY_MULTIPLE_ASSETS' };
    if (!scope.unresolved && scope.assets.length === 1) {
      const a = scope.assets[0];
      const pre = avantLecture('structured.operation_history', scope);
      if (pre) return pre;
      const h = await port.readAssetHistory(accountId, a.id, { assetName: a.name });
      const theme = expenseThemeOf(message);
      // Lot 49 : un objet précis (« la chaudière ») filtre l'historique sur le
      // texte réel des entrées ; rien ne répond → T2, jamais tout l'historique.
      const termes = h ? residu(scope, (message.match(HISTORY_STRIP) ?? [])) : [];
      const entries = (h?.entries ?? []).filter((e) => (!theme || e.theme === theme)
        && (!termes.length || textMatchesTerms(`${e.label} ${e.provider ?? ''}`, termes)));
      if (h && termes.length && !entries.length) return nonResolu('structured.operation_history', termes, scope);
      if (h && entries.length) return historyAnswer(a, entries, theme);
    }
  }

  // ── Contrats : « quel est mon contrat d'assurance pour la Polo ? » (B15) ─
  // Une échéance (« quand expire… ») reste à l'Agenda (C15) ; une recherche
  // explicite du document, à la recherche documentaire (pont, F-130).
  if (CONTRACT_Q.test(m) && CONTRACT_ASK.test(m) && !CONTRACT_NOT.test(m) && port.readContracts) {
    const reste = await sansMotsDeQuestion(message, CONTRACT_STRIP);
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'CONTRACT_MULTIPLE_ASSETS' };
    if (!scope.unresolved) {
      const a = scope.assets.length === 1 ? scope.assets[0] : null;
      const pre = avantLecture('structured.contracts', scope);
      if (pre) return pre;
      const contrats = await port.readContracts(accountId, scope.assets.map((x) => x.id), { assetName: a?.name ?? null });
      const theme = expenseThemeOf(message);
      // Lot 49 : un contrat PRÉCIS (« mon contrat internet ») est cherché dans
      // le texte des contrats réels ; rien ne répond → T2, jamais la liste.
      const termes = contrats.length ? residu(scope, message.match(CONTRACT_STRIP) ?? []) : [];
      const retenus = (theme === 'insurance' ? contrats.filter((c) => /assur/i.test(`${c.label} ${c.provider ?? ''}`)) : contrats)
        .filter((c) => !termes.length || textMatchesTerms(`${c.label} ${c.provider ?? ''} ${c.reference ?? ''}`, termes));
      if (termes.length && !retenus.length) return nonResolu('structured.contracts', termes, scope);
      if (retenus.length) return contractsAnswer(retenus, scope);
    }
  }

  // ── « payé / réglé » ≠ « coûté » (C15, C15.2, F-132) ──────────────────
  if (PAID.test(m) && !COST_WORDS.test(m) && (COUNT.test(m) || PAID_YESNO.test(m)) && (port.readPayments || port.readAcquisition)) {
    const theme = expenseThemeOf(message);
    const year = Number(m.match(/\b(20\d{2})\b/)?.[1]) || undefined;
    const reste = theme ? await sansMotsDeQuestion(await sansMotsDeQuestion(message, PAID_STRIP), THEME_STRIP) : await sansMotsDeQuestion(message, PAID_STRIP);
    const scope = await p.resolveScope(reste);
    if (scope.unresolved) return null;
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'PAID_MULTIPLE_ASSETS' };
    // Lot 49 : « Je paye combien pour INTERNET à la maison ? » — « payé » +
    // « combien » disent qu'un montant est cherché, pas lequel. Un sujet non
    // consommé n'autorise ni le prix d'achat, ni un total des paiements.
    const termesPaye = residu(scope);
    if (termesPaye.length) {
      return nonResolu(!theme && !year && scope.assets.length === 1 ? 'structured.acquisition_price' : 'structured.payments', termesPaye, scope);
    }
    const assetIds = scope.assets.map((a) => a.id);
    const pour = `${scope.label ? ` pour ${scope.label}` : ''}${theme ? ` (${EXPENSE_THEME_LABELS[theme]})` : ''}${year ? ` en ${year}` : ''}`;
    // ══════════════════════════════════════════════════════════════════
    // LOT 111K — « COMBIEN AI-JE PAYÉ ? » DEMANDE UN MONTANT
    //
    // Le verbe « payer » d'une question de MONTANT (« combien ai-je payé
    // pour l'entretien ? ») ne demande pas la justification du règlement :
    // la réponse est le montant documenté (prix d'achat, dépenses
    // qualifiées, coût d'une intervention), avec sa nature, sans réserve
    // sur un règlement non demandé — et sans jamais l'affirmer réglé.
    // Seule une question sur le RÈGLEMENT (« est-ce réglé ? », « ai-je déjà
    // payé ? », « reste-t-il à payer ? », « preuve de paiement ») lit les
    // preuves de paiement (`asksSettlement`, `core/question-focus`).
    // ══════════════════════════════════════════════════════════════════
    const reglement = asksSettlement(message);
    // C15.2 : « J'ai payé combien pour la Polo ? » — prix d'achat d'abord,
    // le cumul des dépenses depuis l'achat à part, jamais additionnés.
    if (!reglement && (!theme || theme === 'purchase') && !year && scope.assets.length === 1 && port.readAcquisition) {
      const r = await acquisitionAnswer(port, accountId, scope.assets[0], theme === 'purchase');
      if (r) return r;
    }
    if (reglement && port.readPayments) {
      const pay = await port.readPayments(accountId, { assetIds, year: year ?? null });
      const q = port.sumQualifiedExpenses ? await port.sumQualifiedExpenses(accountId, { assetIds, year, theme }) : null;
      return paymentsAnswer(pay, q, { pour, scopeLabel: scope.label, assetIds, year, assets: scope.assets });
    }
    // Question de montant : les dépenses qualifiées ci-dessous répondent.
  }

  // ══════════════════════════════════════════════════════════════════════
  // LOT 114A (Trello #753, CDC T2 §5.3, §10.2, D01 / D19, exemples A et B) —
  // QUESTION LARGE SUR LE COÛT D'UN BIEN UNIQUE
  //
  // « Combien m'a coûté mon vélo ? » n'appelle pas de clarification sur le
  // type de coût : la réponse présente ce qui est pertinent ET autorisé.
  //   · offre avec coût de possession : prix d'achat + coût de possession
  //     canonique (service TCO), présentés à part, jamais additionnés ;
  //   · sans ce droit (Standard) : prix d'achat + rappel que le coût de
  //     possession est réservé — AUCUNE lecture TCO, aucune somme de
  //     factures à la place (pas de TCO déguisé).
  // Règle remplacée : cette question recevait le seul total des dépenses
  // documentées par thème. Un thème, une année, une intervention désignée,
  // un ensemble de biens ou un prix d'achat inconnu gardent le traitement
  // historique ci-dessous.
  // ══════════════════════════════════════════════════════════════════════
  if (BROAD_COST.test(m) && COUNT.test(m) && !PAID.test(m) && !isOwnershipCostQuestion(message)
    && !expenseThemeOf(message) && !/\b(19|20)\d{2}\b/.test(m)
    && port.readAcquisition && port.ownershipCostAllowed) {
    const scope = await p.resolveScope(message);
    if (!scope.unresolved && !scope.ambiguous && scope.assets.length === 1
      && residu(scope).length === 0 && specificCostTerms(message, [scope.assets[0].name]).length === 0) {
      const a = scope.assets[0];
      const achat = await acquisitionAnswer(port, accountId, a, true);
      if (achat && 'strategy' in achat) {
        const autorise = await port.ownershipCostAllowed(accountId);
        if (!autorise) {
          const reserve = ownershipCostLockedAnswer(a) as Extract<CanonicalLevel1, { strategy: CanonicalStrategy }>;
          const sources = uniques([...achat.sources, ...reserve.sources]);
          // Carte #790 (relance) : le prix d'achat, puis la réserve d'offre — deux blocs, jamais une seule ligne.
          const answer = `${achat.answer}\n\n${TCO_PREMIUM_MESSAGE}`;
          return {
            strategy: 'structured.acquisition_price', answer, sources, kind: 'exact',
            claims: [claim('acquisition', achat.answer, achat.sources, 'direct'), claim('ownership_cost_locked', TCO_PREMIUM_MESSAGE, reserve.sources, 'direct')],
          };
        }
        // Carte #880 (R02) : une lecture TCO en erreur n'est plus avalée en silence — le prix d'achat (fiable)
        // est conservé et la limite est dite.
        let tcoEnErreur = false;
        const tco = port.readOwnershipCost ? await port.readOwnershipCost(accountId, a.id).catch((e: unknown) => {
          tcoEnErreur = (e as Error | undefined)?.name !== 'AssetNotFoundForTcoError';
          if (tcoEnErreur) console.error('[verebona] lecture TCO impossible', { accountId, assetId: a.id, error: (e as Error | undefined)?.name ?? String(e) });
          return null;
        }) : null;
        if (!tco && tcoEnErreur) {
          return { ...achat, answer: `${achat.answer}\n\nLe coût de possession de ${a.name} n’a pas pu être lu pour le moment ; il reste consultable depuis la fiche du bien.` };
        }
        const possession = tco ? ownershipCostAnswer(a, tco) : null;
        if (possession && 'strategy' in possession) {
          const sources = uniques([...achat.sources, ...possession.sources]);
          return {
            // Carte #790 (relance) : le prix d'achat, puis le coût de possession en blocs — présentés à part, jamais additionnés.
            strategy: 'structured.ownership_cost', answer: `${achat.answer}\n\n${possession.answer}`, sources, kind: 'calc',
            claims: [claim('acquisition', achat.answer, achat.sources, 'direct'), claim('ownership_cost', possession.answer, possession.sources, 'calculated')],
          };
        }
        return achat;
      }
    }
  }

  // ── Dépenses qualifiées (T2-24) ────────────────────────────────────────
  if (SPEND.test(m) && (COUNT.test(m) || /\b(total|somme)\b/.test(m)) && port.sumQualifiedExpenses) {
    const theme = expenseThemeOf(message);
    const reste = theme ? await sansMotsDeQuestion(message, THEME_STRIP) : message;
    const scope = await p.resolveScope(reste);
    // Lot 45 (C15 « coût d'une opération précise », F-127) : « combien a
    // coûté la réparation du TOIT ? » — l'intervention désignée par son
    // libellé répond par son coût CONSOLIDÉ (jamais resommé, 16.3). Rien de
    // désigné : agrégat ci-dessous ; mot inconnu sans intervention : repli
    // documentaire (F-128).
    if (port.readOperationCosts && !scope.ambiguous) {
      const termes = specificCostTerms(message, scope.assets.map((a) => a.name));
      const couts = termes.length ? await port.readOperationCosts(accountId, termes, scope.unresolved ? [] : scope.assets.map((a) => a.id)) : [];
      if (couts.length) return operationCostAnswer(couts, scope);
    }
    if (scope.unresolved) return null;
    // Lot 49 : intervention non désignée par les données ET sujet non
    // consommé (« combien me coûte internet à la maison ? ») : jamais l'agrégat
    // de la catégorie ou du bien — T2 reprend la main.
    // Lot 114A (#753, CDC T2 P0/M08) — barrière de cardinalité AVANT tout calcul :
    // « combien m'a coûté mon vélo ? » avec deux vélos ne reçoit jamais le total
    // des deux. Seul un ensemble explicitement demandé (« mes vélos ») est sommé.
    if (!aggregateAllowed(scope)) return { ambiguous: scope.assets, reason: 'SUM_MULTIPLE_ASSETS' };
    const termesCout = scope.ambiguous ? [] : residu(scope);
    if (termesCout.length) return nonResolu('structured.sum_qualified', termesCout, scope);
    const year = Number(m.match(/\b(20\d{2})\b/)?.[1]) || undefined;
    const q = await port.sumQualifiedExpenses(accountId, { assetIds: scope.assets.map((a) => a.id), year, theme });
    const pour = `${scope.label ? ` pour ${scope.label}` : ''}${year ? ` en ${year}` : ''}`;
    // Source qui PORTE le total (thème, complétude, documents inclus) : une
    // reformulation par le modèle reste vérifiable (claim-support, T2-31).
    const sources = [
      expenseSumSource(q, { assetIds: scope.assets.map((a) => a.id), scopeLabel: scope.label, year }),
      // Lot 45 : interventions, contrats, achats, sinistres comptés — chacun
      // s'ouvre sur son document (ou la section Sinistres), jamais sur une
      // « Opération » (P09).
      ...operationSources(q, scope.assets),
      ...scope.assets.map(assetSrc),
    ];
    // Non qualifiés : nature non précisée et/ou (année demandée) date absente.
    const sansDate = q.unqualified.undatedCount ?? 0;
    const sansNature = q.unqualified.count - sansDate;
    const pl = (n: number, a: string, b: string) => (n > 1 ? b : a);
    const motifs = [
      sansNature ? `${sansNature} document${pl(sansNature, '', 's')} avec montant ne précise${pl(sansNature, '', 'nt')} pas leur nature` : null,
      sansDate ? `${sansDate} document${pl(sansDate, '', 's')} avec montant n’${pl(sansDate, 'a', 'ont')} pas de date (non qualifié${pl(sansDate, '', 's')})` : null,
    ].filter(Boolean).join(' ; ');
    const incomplet = q.unqualified.count > 0
      ? ` Non compté${pl(q.unqualified.count, '', 's')} : ${motifs} — le total peut être incomplet.`
      : '';
    const doublons = q.duplicates?.count ? ` Doublon${pl(q.duplicates.count, '', 's')} signalé${pl(q.duplicates.count, '', 's')} (fusion possible) écarté${pl(q.duplicates.count, '', 's')} : ${q.duplicates.count} — chaque document n’est compté qu’une fois.` : '';
    // Lot 45 : les preuves de paiement (exclues, P16) sont dites à part (notes).
    const autresExclus = q.excluded.count - (q.excluded.byType?.PAYMENT_PROOF ?? 0);
    const exclus = autresExclus > 0 ? ` Les devis et documents sans valeur de dépense (${autresExclus}) ne sont pas comptés.` : '';
    // Lot 45 (C15.1 §33) : provenance et parts non comptées du mode mixte.
    const notes = mixedExpenseNotes(q, { scopeLabel: scope.label, year: year ?? null });
    // ════════════════════════════════════════════════════════════════════
    // Carte #790, relance du 21/11/2026 (E03) — la réponse déclare ses parties : le total (ou la liste par
    // thème puis le total), et À PART les réserves (non comptés, provenance, doublons écartés, devis exclus).
    // Règle remplacée : tout était écrit à la suite sur une ligne. Mêmes phrases, mêmes montants.
    // ════════════════════════════════════════════════════════════════════
    const reserves = (...xs: string[]): AnswerPart => ({ kind: 'list', intro: EXPENSE_NOTES_INTRO, items: xs.map((x) => x.trim()).filter(Boolean) });
    let parts: AnswerPart[];
    let kind: 'calc' | 'no_result' = 'calc';
    if (theme) {
      const t = q.byTheme[0];
      if (!t) {
        kind = 'no_result';
        parts = [{
          kind: 'paragraph',
          text: q.unqualified.count > 0
            // Couverture incomplète : aucun total affirmé (T2-24).
            ? `Je ne peux pas isoler vos dépenses ${deFr(EXPENSE_THEME_LABELS[theme])}${pour} : ${motifs}. ${expenseCompletionHint(sansNature, sansDate)}`
            : formatNoResult(`aucune dépense ${deFr(EXPENSE_THEME_LABELS[theme])} documentée`, pour.trim() || undefined),
        }, reserves(...notes)];
      } else {
        parts = [
          { kind: 'paragraph', text: `Dépenses ${deFr(t.label)} documentées${pour} : ${formatAmountCents(t.sumCents)} (${expenseItemsLabel(t, q.operations)}).` },
          reserves(incomplet, ...notes, doublons, exclus),
        ];
      }
    } else if (q.byTheme.length === 0) {
      kind = 'no_result';
      parts = [{
        kind: 'paragraph',
        text: q.unqualified.count > 0
          ? `Je ne peux pas totaliser vos dépenses${pour} : ${motifs}.`
          : formatNoResult('aucune dépense documentée', pour.trim() || undefined),
      }, reserves(...notes)];
    } else {
      const lignes = q.byTheme.map((t) => `${t.label} ${formatAmountCents(t.sumCents)} (${t.count})`);
      const titre = `Dépenses documentées${pour}, par thème`;
      parts = [
        lignes.length > 1 ? { kind: 'list', intro: titre, items: listItems(lignes) } : { kind: 'paragraph', text: `${titre} : ${lignes[0]}.` },
        { kind: 'paragraph', text: `Total des dépenses qualifiées : ${formatAmountCents(q.qualifiedSumCents)}.` },
        reserves(incomplet, ...notes, doublons, exclus),
      ];
    }
    const answer = composeAnswerText(parts.filter((x) => x.kind !== 'list' || x.items.length > 0));
    return { strategy: 'structured.sum_qualified', answer, sources, claims: [claim('sum', answer, sources, 'calculated')], kind };
  }

  // ── Échéances à venir, fenêtre (T2-15) ─────────────────────────────────
  const upcoming = upcomingAgendaRequest(message);
  if (upcoming && !COUNT.test(m) && port.listUpcomingAgenda) {
    const reste = await sansMotsDeQuestion(message, AGENDA_STRIP);
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'UPCOMING_MULTIPLE_ASSETS' };
    if (scope.unresolved) return null;
    const rows = await port.listUpcomingAgenda(accountId, { assetIds: scope.assets.map((a) => a.id), windowDays: upcoming.windowDays, limit: 10 });
    const fenetre = upcoming.windowDays <= 7 ? 'dans les 7 prochains jours' : `dans les ${upcoming.windowDays} prochains jours`;
    const sources: RetrievedSource[] = rows.map((r) => ({
      id: `agenda_${r.id}`, type: 'agenda_item', title: r.title,
      content: `${r.date}${r.forecast ? ' · date prévisionnelle' : ''}${r.assetNames.length ? ` · ${r.assetNames.join(', ')}` : ''}`,
      relevanceScore: 1, meta: { date: r.date, forecast: r.forecast },
    }));
    const answer = rows.length === 0
      ? formatNoResult(`aucune échéance ${fenetre}`, scope.label ? `pour ${scope.label}` : undefined)
      : formatListBlocks(`Échéances ${fenetre}${scope.label ? ` pour ${scope.label}` : ''}`, rows.map((r) =>
        `« ${r.title} »${r.assetNames.length && !scope.label ? ` (${joinFr(r.assetNames)})` : ''} ${r.forecast ? 'prévue le' : 'le'} ${formatDateFr(r.date)} (${formatRelativeDays(daysBetween(today, r.date))})`), 10)
        // Carte #790 (relance) : la réserve sur les dates prévisionnelles est un paragraphe à part.
        + (rows.some((r) => r.forecast) ? `${rows.length > 1 ? '\n\n' : ' '}Les dates « prévues » sont prévisionnelles : elles seront confirmées par un document.` : '');
    const srcs = sources.length ? sources : scope.assets.map(assetSrc);
    return { strategy: 'structured.upcoming_agenda', answer, sources: srcs, claims: [claim('upcoming', answer, srcs, 'calculated')], kind: rows.length ? 'list' : 'no_result' };
  }

  // ── Champ d'un bien (T2-22, T2-23, T2-32) ──────────────────────────────
  const champ = findReadableField(message) ?? purchaseQuestion(message);
  if (champ && isFieldQuestion(message) && port.readAssetField) {
    const reste = await sansMotsDeQuestion(plain(message), wholeWords(esc(champ.phrase), 'g'));
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'FIELD_MULTIPLE_ASSETS' };
    if (scope.unresolved || scope.assets.length !== 1) return null;
    const a = scope.assets[0];
    // Lot 75J (#419 R06) : un sujet significatif que ni la phrase du champ ni son libellé ne
    // consomment (« le kilométrage de la Polo pour le contrat Leasys ») renvoie à T2 AVANT lecture.
    const pre = structuredScopeBarrier('structured.asset_field', message, [a.name], [champ.def.label], [champ.phrase]);
    if (!pre.semanticScopeResolved) return nonResolu('structured.asset_field', pre.unresolvedSemanticTerms, scope);
    const r = await port.readAssetField(accountId, a.id, champ.def.key);
    // Non renseigné : les documents (niveau 2) peuvent encore porter la valeur.
    if (!r || r.value === null || r.value === undefined || r.display === null) return null;
    const answer = fieldAnswer(r);
    const sources = [assetFieldSource(r)];
    return {
      strategy: 'structured.asset_field', answer, sources,
      claims: [claim(`field:${r.key}`, answer, sources, 'direct')],
      kind: 'exact',
    };
  }
  return null;
}

/**
 * Phrase de réponse d'un champ (pure, testée) : valeur, conflit.
 *
 * Lot 33 : plus aucune mention de la SOURCE ni de son origine dans le texte
 * (« Valeur saisie par vous », « Valeur lue dans un document (« … ») ») —
 * la traçabilité reste interne : source `asset_field` (origine, preuve,
 * date), claims en base, BO. Le conflit ouvert reste signalé : c'est une
 * action à mener, pas une citation de source.
 */
export function fieldAnswer(r: CanonicalFieldReading): string {
  // Lot 18 (R3) : champ vide sur le bien mais renseigné sur ses équipements
  // ou pièces — chaque valeur est rattachée à SON équipement / SA pièce.
  if (!r.display && r.entities?.length) {
    const lignes = r.entities.filter((e) => e.display && !e.sensitive).map((e) => {
      const nom = e.entityName ?? (e.target.type === 'ROOM' ? 'la pièce' : 'l’équipement');
      return `${e.label} de ${nom} : ${e.display}.`;
    });
    // Carte #790 recentrée (§1) — règle remplacée : `lignes.join(' ')`. Plusieurs équipements ou pièces : une valeur
    // par ligne (liste) ; un seul : la phrase d'avant, inchangée.
    if (lignes.length) return lignes.length > 1 ? composeAnswerText([{ kind: 'list', items: lignes }]) : lignes[0];
  }
  const valeur = r.key === 'acquisitionDate' && r.display
    ? `Vous avez acheté ${r.assetName ?? 'ce bien'} le ${r.display}.`
    : `${r.label} de ${r.assetName ?? 'ce bien'} : ${r.display}.`;
  // Carte #790 recentrée (§1) — règle remplacée : la réserve de conflit suivait la valeur sur la même ligne. La
  // valeur d'abord, seule ; l'action à mener dans son propre paragraphe. Sans conflit : la phrase d'avant, inchangée.
  const conflit = r.openConflict ? `\n\nUn autre document propose une valeur différente : c’est à arbitrer dans « À traiter » (${r.openConflict.question}).` : '';
  return `${valeur}${conflit}`;
}
