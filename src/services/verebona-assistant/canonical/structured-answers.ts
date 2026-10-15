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
import { listFields, type CanonicalFieldDef } from '@/services/canonical/registry';
import type { Claim, RetrievedSource } from '../types/sources';
import type { AccountDataPort, AssetRow } from '../core/data-answer.service';
import {
  daysBetween, formatAmountCents, formatDateFr, formatList, formatNoResult, formatRelativeDays, joinFr,
} from '../core/deterministic-format';
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

export interface ScopeLike { assets: AssetRow[]; ambiguous: boolean; unresolved: boolean; label: string | null }

export type CanonicalStrategy =
  | 'structured.asset_field' | 'structured.upcoming_agenda' | 'structured.missing_information' | 'structured.sum_qualified'
  // Lot 45 (O6) : lecture « Opération d'abord » (CDC Opérations V1 C15).
  | 'structured.operation_history' | 'structured.claim_status' | 'structured.payments' | 'structured.acquisition_price'
  | 'structured.contracts' | 'structured.operation_cost'
  // Lot 54D (§4.3) : coût de possession (service TCO).
  | 'structured.ownership_cost';

export type CanonicalLevel1 =
  | { strategy: CanonicalStrategy; answer: string; sources: RetrievedSource[]; claims: Claim[]; kind: 'exact' | 'list' | 'calc' | 'no_result' | 'conflict' }
  | { ambiguous: AssetRow[]; reason: string }
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
export type CanonicalAnswer = Extract<NonNullable<CanonicalLevel1>, { strategy: CanonicalStrategy }>;

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");
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
export type FieldRequestForm = 'question' | 'command' | 'count' | 'undetermined';
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
const CLAIM_STRIP = /sinistres?|o[uù] en (est|sont)|statut|[ée]tat|avancement|indemni\w*|rembours\w*|dossiers?|suivi|d[ée]clar\w*|expert\w*/gi;

/**
 * Historique d'un bien (« qu'est-ce qui a été fait sur la Polo ? », « quelles
 * réparations sur la maison ? », « historique des interventions »).
 */
export const HISTORY_Q = /(qu'?est-ce qu'?(il|on) a ete fait|qu'?est-ce qui a ete (fait|realise)|ce qui a ete (fait|realise)|que s'?est-il passe|qu'?a-t-on fait|quel(le)?s? (interventions?|reparations?|travaux|entretiens?|operations?)\b(?! (prevue?s?|a venir|prochaine?s?))|historique des (interventions|reparations|travaux|entretiens|depenses)|(interventions?|travaux|reparations?) (realise(e)?s?|faite?s?|effectue(e)?s?) (sur|dans|a|au|pour))/;
/** Une question sur l'avenir (« prévus », « à faire ») n'est pas un historique : Agenda / actions. */
const HISTORY_NOT = /\b(prevue?s?|a venir|prochaine?s?|planifie\w*|futur\w*|dois|devrai\w*|faut|a faire|a prevoir)\b/;
const HISTORY_STRIP = /qu['’]?est-ce qu['’]?(il|on) a [ée]t[ée] fait|qu['’]?est-ce qui a [ée]t[ée] (fait|r[ée]alis[ée])|ce qui a [ée]t[ée] (fait|r[ée]alis[ée])|que s['’]?est-il pass[ée]|qu['’]?a-t-on fait|historique|interventions?|r[ée]parations?|travaux|entretiens?|op[ée]rations?|r[ée]alis[ée]e?s?|faite?s?|effectu[ée]e?s?|quel(le)?s?/gi;

/**
 * Lot 54D (§4.3) : question de COÛT DE POSSESSION d'un bien (« combien m'a
 * coûté la Polo au total ? », « coût de possession », « TCO ») — T2 lit le
 * service TCO, jamais un calcul parallèle.
 */
export const TCO_Q = /\b(couts? (total|totaux|global|globaux|complet|reel) de (possession|detention)|couts? de (possession|detention)|tco|cout total|cout global|au total (m'?a|a) coute|m'?a coute au total|combien (m'?a|a) coute .*\bau total\b|combien (me|m'?a) coute (de|d') ?(posseder|avoir))\b/;
/** Question de coût de possession (pure) : un thème (« coût total des réparations ») ou une année reste un total de dépenses (T2-24). */
export function isOwnershipCostQuestion(message: string): boolean {
  const m = plain(message);
  return TCO_Q.test(m) && !expenseThemeOf(message) && !/\b(19|20)\d{2}\b/.test(m);
}
const TCO_STRIP = /co[uû]ts? (total|totaux|global|globaux|complet|r[ée]el) de (possession|d[ée]tention)|co[uû]ts? de (possession|d[ée]tention)|tco|co[uû]t total|co[uû]t global|au total|combien|m['’]?a|co[uû]t[ée]?|me|de|d['’]|poss[ée]der|avoir|quel|est|le|la|mon|ma/gi;

/** « payé / réglé » (C15) — distinct de « coûté / dépensé » (F-132, F-133). */
export const PAID = /\b(paye|payee|payes|payees|payer|regle|reglee|regles|reglees|regler|acquitte(e|es|s)?|verse|versee|versees)\b/;
const COST_WORDS = /\b(coute|coutee|coutes|cout|couts|depense\w*)\b/;
const PAID_YESNO = /\b(a-t-(il|elle) ete|ont-(ils|elles) ete|est-(il|elle)|sont-(ils|elles)|deja)\b/;
const PAID_STRIP = /pay[ée]e?s?|payer|r[ée]gl[ée]e?s?|r[ée]gler|acquitt[ée]e?s?|vers[ée]e?s?|combien|ai-je|j['’]ai|deja|déjà|a-t-(il|elle)|est-(il|elle)|[ée]t[ée]/gi;

/** Question sur un contrat (assurance, abonnement, entretien, location). */
export const CONTRACT_Q = /\b(contrats?|polices? d'assurance)\b|\b(assurances?|abonnements?)\b.*\b(quel|quelle|quels|quelles|mes|ai-je|en cours|souscrit\w*)\b|\b(quel|quelle|quels|quelles|mes)\b.*\b(assurances?|abonnements?)\b/;
const CONTRACT_ASK = /\b(quel|quelle|quels|quelles|mes|ai-je|en cours|souscrit\w*|liste|qui|aupres de qui|chez qui)\b/;
const CONTRACT_NOT = /\b(expire\w*|expiration|echeance\w*|renouvel\w*|fin de|combien|retrouve\w*|montre|affiche|ouvre|cherche\w*|resilie\w*|comment)\b/;
const CONTRACT_STRIP = /contrats?|polices?|assurances?|abonnements?|en cours|souscrits?|aupr[eè]s de qui|chez qui|quel(le)?s?/gi;

/**
 * Lot 49 : noms GÉNÉRIQUES d'une dépense (pièce, frais, intervention) — ils
 * désignent la dépense elle-même, jamais un sujet précis.
 */
const MOTS_DEPENSE = ['facture', 'factures', 'document', 'documents', 'frais', 'intervention', 'interventions', 'operation', 'operations', 'achats'];

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
    : formatList(`Vous avez ${claims.length} sinistres${scope.label ? ` pour ${scope.label}` : ''}`, claims.map((c) => ligne(c, false)), 8);
  const scopeIds = new Set(scope.assets.map((a) => a.id));
  const sources: RetrievedSource[] = claims.slice(0, SOURCES_MAX).map((c): RetrievedSource | null => {
    const assetId = c.assetIds.find((id) => scopeIds.has(id)) ?? c.assetIds[0] ?? null;
    const content = ligne(c, true);
    return assetId
      ? { id: claimSourceId(assetId, c.operationId), type: 'asset_field', title: `${c.label.charAt(0).toUpperCase()}${c.label.slice(1)}`, content, relevanceScore: 1, meta: { assetId, assetName: noms.get(assetId) ?? null, date: c.occurredOn } }
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
    : formatList('Coûts correspondants', couts.map((c) => { const l = ligne(c); return `${l.lab.charAt(0).toUpperCase()}${l.lab.slice(1)} : ${l.txt}`; }), 5);
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
  ].join('');
  const answer = contrats.length === 1
    ? `${ligne(contrats[0])}.`
    : formatList(`Contrats${scope.label ? ` de ${scope.label}` : ''}`, contrats.map(ligne), 8);
  const sources = uniques(contrats.map((c) => c.source)).slice(0, SOURCES_MAX);
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
  const answer = `${titre} :\n${lignes.map((l) => `• ${l}`).join('\n')}`;
  const sources = uniques(entries.map((e) => e.source)).slice(0, 8);
  const srcs = sources.length ? sources : [assetSrc(a)];
  return { strategy: 'structured.operation_history', answer, sources: srcs, claims: [claim('history', answer, srcs, 'direct')], kind: 'list' };
}

/**
 * Lot 54D (§4.3) — réponse « coût de possession » : chiffres du service TCO
 * (moteur partagé), jamais recalculés ici. La source porte chaque montant cité
 * (vérifiable par `claim-support`) ; une couverture incomplète est dite.
 */
export function ownershipCostAnswer(a: AssetRow, t: import('@/services/business-operations/tco/model').TcoResult): CanonicalLevel1 {
  const postes = t.breakdown.map((b) => `${b.label.toLowerCase()} ${formatEur(b.costsCents)}`);
  if (t.reductionsCents) postes.push(`avoirs − ${formatEur(t.reductionsCents)}`);
  if (t.refundsCents) postes.push(`remboursements − ${formatEur(t.refundsCents)}`);
  if (t.indemnitiesCents) postes.push(`indemnités − ${formatEur(t.indemnitiesCents)}`);
  const phrases = [`Coût de possession de ${a.name} : coût cumulé documenté ${formatEur(t.summary.cumulativeCostCents)}${postes.length ? ` (${postes.join(', ')})` : ''}${t.period.start ? `, depuis le ${formatDateFr(t.period.start)}` : ''}.`];
  if (t.disposed) {
    phrases.push(t.summary.netFinalCents != null
      ? `Après la vente (prix réalisé ${formatEur(t.disposal.realizedPriceCents ?? 0)}), coût net final : ${formatEur(t.summary.netFinalCents)}.`
      : 'Le prix de cession réalisé n’est pas documenté : le coût net final n’est pas établi.');
  } else if (t.summary.currentValue && t.summary.netEstimatedCents != null) {
    phrases.push(`Valeur actuelle ${formatEur(t.summary.currentValue.cents)} (au ${formatDateFr(t.summary.currentValue.date)}) : coût net estimé ${formatEur(t.summary.netEstimatedCents)}.`);
  } else {
    phrases.push('Aucune valorisation datée : seul le coût cumulé est indiqué, aucune dépréciation n’est estimée.');
  }
  if (t.reliability.unconverted.length) phrases.push(`Non comptés (devise sans contre-valeur en euros) : ${t.reliability.unconverted.map((u) => formatMinorAmount(u.amountMinor, u.currency)).join(', ')}.`);
  if (t.reliability.unallocated.count) phrases.push('Des montants communs à plusieurs biens ne sont pas ventilés et ne sont pas comptés.');
  if (t.status !== 'COMPLETE') phrases.push(t.status === 'PARTIAL' ? 'Résultat partiel.' : 'Ce total peut être incomplet.');
  if (t.usage.annualEstimateCents) phrases.push(`Budget d’usage estimé (forfaits, non compté dans le coût) : ${formatEur(t.usage.annualEstimateCents)} par an.`);
  const answer = phrases.join(' ');
  const src: RetrievedSource = {
    id: `tco:${a.id}`, type: 'document_extraction', title: `Coût de possession — ${a.name}`, content: answer.slice(0, 1500), relevanceScore: 1,
    meta: {
      assetId: a.id, assetName: a.name, cumulativeCostCents: t.summary.cumulativeCostCents, netEstimatedCents: t.summary.netEstimatedCents,
      netFinalCents: t.summary.netFinalCents, status: t.status, operationCount: t.reliability.operationsCounted,
      includedDocuments: t.reliability.documents.slice(0, 50).map((d) => `doc-${d.fileId}`).join(' '),
    },
  };
  const sources = [src];
  return { strategy: 'structured.ownership_cost', answer, sources, claims: [claim('ownership_cost', answer, sources, 'calculated')], kind: 'exact' };
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
  let answer = `Prix d’achat de ${a.name} : ${prix}${acq?.date ? ` (achat du ${formatDateFr(acq.date)})` : ''}.`;
  answer += acquisitionSideNotes(acq);
  if (!achatSeul && port.sumQualifiedExpenses) {
    const q = await port.sumQualifiedExpenses(accountId, { assetIds: [a.id], theme: null });
    const hors = q.byTheme.filter((t) => t.theme !== 'purchase' && t.sumCents);
    const somme = hors.reduce((n, t) => n + t.sumCents, 0);
    if (hors.length && somme) {
      answer += ` Si vous parlez des dépenses depuis l’achat (hors prix d’achat) : ${formatEur(somme)} (${hors.map((t) => `${t.label} ${formatEur(t.sumCents)}`).join(', ')})${q.complete ? '' : ', total peut-être incomplet'}. Ces deux montants ne s’additionnent pas sans que vous le demandiez.`;
      sources.push(expenseSumSource(q, { assetIds: [a.id], scopeLabel: a.name }));
    }
  }
  return { strategy: 'structured.acquisition_price', answer, sources, claims: [claim('acquisition', answer, sources, 'direct')], kind: 'exact' };
}

/**
 * Lot 53D (retour PO D9) — écarts et frais annexes de l'achat (pure, testée) :
 * la valeur saisie reste la référence, l'écart avec un document est dit (pas
 * effacé), les frais connus sont cités à part, jamais additionnés.
 */
export function acquisitionSideNotes(acq: Pick<import('./operations').AcquisitionRead, 'priceCents' | 'documentPrices' | 'fees'> | null | undefined): string {
  if (!acq) return '';
  const out: string[] = [];
  const titre = (t: string | null) => (t ? ` « ${t.slice(0, 60)} »` : '');
  for (const d of (acq.documentPrices ?? []).slice(0, 2)) {
    out.push(`Le document${titre(d.title)} indique ${formatMinorAmount(d.amountMinor, d.currency)} : la valeur saisie sur la fiche est conservée comme référence.`);
  }
  const fees = acq.fees ?? [];
  if (fees.length) {
    out.push(`Frais annexes connus, non inclus dans ce prix : ${fees.slice(0, 3).map((f) => `${formatMinorAmount(f.amountMinor, f.currency)}${titre(f.title)}`).join(', ')}.`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
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
  let answer: string;
  let kind: 'calc' | 'no_result' = 'calc';
  const docs: RetrievedSource[] = pay.proofs.slice(0, SOURCES_MAX).map((p) => ({
    id: `doc_${p.fileId}`, type: 'document', title: p.title,
    content: `Preuve de paiement « ${p.title} »${p.date ? ` · ${p.date}` : ''}${p.amountCents != null ? ` · montant réglé : ${formatEur(p.amountCents)}` : ' · montant non lisible'}`,
    relevanceScore: 1, meta: { fileId: p.fileId, date: p.date },
  }));
  if (pay.proofs.length) {
    const n = pay.proofs.length;
    answer = `Règlements justifiés${ctx.pour} : ${formatEur(pay.sumCents)} (${n} preuve${pl(n, '', 's')} de paiement : ${joinFr(pay.proofs.slice(0, 4).map((p) => `« ${p.title} »`))}${n > 4 ? '…' : ''}).`;
    if (pay.withoutAmount) answer += ` ${pay.withoutAmount} preuve${pl(pay.withoutAmount, '', 's')} sans montant lisible.`;
    if (cout) {
      answer += ` Coût documenté${ctx.pour} : ${formatEur(cout)}${q!.complete ? '' : ' (total peut-être incomplet)'}.`;
      if (cout > pay.sumCents) answer += ` Je n’ai pas de preuve de règlement pour ${formatEur(cout - pay.sumCents)}.`;
    }
  } else {
    answer = `Je n’ai trouvé aucune preuve de paiement${ctx.pour} : je ne peux pas confirmer ce qui a été réglé.`;
    if (cout) answer += ` Le coût documenté${ctx.pour} est de ${formatEur(cout)} : ce montant ne prouve pas qu’il a été réglé.`;
    else kind = 'no_result';
  }
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
): { semanticScopeResolved: boolean; unresolvedSemanticTerms: string[] } {
  const d = STRATEGY_SCOPE[strategy];
  if (d.scope === 'structural') return { semanticScopeResolved: true, unresolvedSemanticTerms: [] };
  const consumed = [...expenseThemeWords(message), ...MOTS_DEPENSE, ...Object.values(EXPENSE_THEME_LABELS), ...(d.vocabulary ? message.match(d.vocabulary) ?? [] : []),
    // Stratégie DÉSIGNÉE : les données réellement servies consomment le sujet qu'elles portent.
    ...(d.scope === 'designated' ? served : [])];
  // Même correspondance que la lecture des données (« toit » → « toiture »).
  const servi = d.scope === 'designated' ? served.join(' ') : '';
  const terms = semanticResidue(message, { assetNames, consumed }).filter((t) => !servi || !textMatchesTerms(servi, [t]));
  return { semanticScopeResolved: terms.length === 0, unresolvedSemanticTerms: terms };
}

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
  const assets = (dernier as ScopeLike | null)?.assets ?? [];
  const b = structuredScopeBarrier(r.strategy, p.message, assets.map((a) => a.name), [r.answer, ...r.sources.map((x) => x.title ?? '')]);
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
  /** Résidu sémantique d'une stratégie candidate (lot 49) : ce qu'elle ne consomme pas. */
  const residu = (scope: ScopeLike, consumed: readonly string[] = []) =>
    semanticResidue(message, { assetNames: scope.assets.map((a) => a.name), consumed: [...expenseThemeWords(message), ...MOTS_DEPENSE, ...consumed] });
  const nonResolu = (strategyCandidate: CanonicalStrategy, terms: string[], scope: ScopeLike): ScopeUnresolved =>
    ({ scopeUnresolved: { strategyCandidate, terms, assetIds: scope.assets.map((a) => a.id) } });

  // ── Informations manquantes (T2-04) ────────────────────────────────────
  if (MISSING.test(m) && port.listMissingInformation) {
    const reste = message.replace(/informations?|manqu\w*|incompl\w*|compl[eé]ter|renseign\w*/gi, ' ');
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
      : formatList(scope.label ? `Informations à compléter pour ${scope.label}` : 'Informations à compléter', lignes, 10);
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
  if (isOwnershipCostQuestion(message) && port.readOwnershipCost) {
    const scope = await p.resolveScope(message.replace(TCO_STRIP, ' '));
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'TCO_MULTIPLE_ASSETS' };
    if (!scope.unresolved && scope.assets.length === 1) {
      const a = scope.assets[0];
      // Lot 54E (#419 écart 7) : barrière transversale AVANT exécution —
      // « combien m'a coûté internet au total ? » n'est pas le coût du bien.
      const b = structuredScopeBarrier('structured.ownership_cost', message, [a.name]);
      if (!b.semanticScopeResolved) return nonResolu('structured.ownership_cost', b.unresolvedSemanticTerms, scope);
      const tco = await port.readOwnershipCost(accountId, a.id).catch(() => null);
      if (tco) return ownershipCostAnswer(a, tco);
    }
  }

  // ── Sinistres : « où en est mon sinistre ? », indemnité ───────────────
  if (CLAIM_Q.test(m) && CLAIM_ASK.test(m) && !/\bcomment\b/.test(m) && port.readClaims) {
    const reste = message.replace(CLAIM_STRIP, ' ');
    const scope = await p.resolveScope(reste);
    if (!scope.unresolved) {
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
    const reste = message.replace(HISTORY_STRIP, ' ');
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'HISTORY_MULTIPLE_ASSETS' };
    if (!scope.unresolved && scope.assets.length === 1) {
      const a = scope.assets[0];
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
    const reste = message.replace(CONTRACT_STRIP, ' ');
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'CONTRACT_MULTIPLE_ASSETS' };
    if (!scope.unresolved) {
      const a = scope.assets.length === 1 ? scope.assets[0] : null;
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
    const reste = message.replace(PAID_STRIP, ' ')
      .replace(theme ? new RegExp(Object.values(EXPENSE_THEME_LABELS).join('|') + '|entretien|revision|reparations?|travaux|assurances?|achat', 'gi') : /$^/, ' ');
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
    // C15.2 : « J'ai payé combien pour la Polo ? » — prix d'achat d'abord,
    // le cumul des dépenses depuis l'achat à part, jamais additionnés.
    if ((!theme || theme === 'purchase') && !year && scope.assets.length === 1 && port.readAcquisition) {
      const r = await acquisitionAnswer(port, accountId, scope.assets[0], theme === 'purchase');
      if (r) return r;
    }
    if (port.readPayments) {
      const pay = await port.readPayments(accountId, { assetIds, year: year ?? null });
      const q = port.sumQualifiedExpenses ? await port.sumQualifiedExpenses(accountId, { assetIds, year, theme }) : null;
      return paymentsAnswer(pay, q, { pour, scopeLabel: scope.label, assetIds, year, assets: scope.assets });
    }
  }

  // ── Dépenses qualifiées (T2-24) ────────────────────────────────────────
  if (SPEND.test(m) && (COUNT.test(m) || /\b(total|somme)\b/.test(m)) && port.sumQualifiedExpenses) {
    const theme = expenseThemeOf(message);
    const reste = theme ? message.replace(new RegExp(Object.values(EXPENSE_THEME_LABELS).join('|') + '|entretien|revision|reparations?|travaux|assurances?|achat', 'gi'), ' ') : message;
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
    const mixte = notes.length ? ` ${notes.join(' ')}` : '';
    let answer: string;
    let kind: 'calc' | 'no_result' = 'calc';
    if (theme) {
      const t = q.byTheme[0];
      if (!t) {
        kind = 'no_result';
        answer = (q.unqualified.count > 0
          // Couverture incomplète : aucun total affirmé (T2-24).
          ? `Je ne peux pas isoler vos dépenses de ${EXPENSE_THEME_LABELS[theme]}${pour} : ${motifs}. Complétez-les (type, date du document) pour obtenir un total fiable.`
          : formatNoResult(`aucune dépense de ${EXPENSE_THEME_LABELS[theme]} documentée`, pour.trim() || undefined)) + mixte;
      } else {
        answer = `Dépenses de ${t.label} documentées${pour} : ${formatAmountCents(t.sumCents)} (${expenseItemsLabel(t, q.operations)}).${incomplet}${mixte}${doublons}${exclus}`;
      }
    } else if (q.byTheme.length === 0) {
      kind = 'no_result';
      answer = (q.unqualified.count > 0
        ? `Je ne peux pas totaliser vos dépenses${pour} : ${motifs}.`
        : formatNoResult('aucune dépense documentée', pour.trim() || undefined)) + mixte;
    } else {
      answer = `${formatList(`Dépenses documentées${pour}, par thème`, q.byTheme.map((t) => `${t.label} ${formatAmountCents(t.sumCents)} (${t.count})`))} Total des dépenses qualifiées : ${formatAmountCents(q.qualifiedSumCents)}.${incomplet}${mixte}${doublons}${exclus}`;
    }
    return { strategy: 'structured.sum_qualified', answer, sources, claims: [claim('sum', answer, sources, 'calculated')], kind };
  }

  // ── Échéances à venir, fenêtre (T2-15) ─────────────────────────────────
  const upcoming = upcomingAgendaRequest(message);
  if (upcoming && !COUNT.test(m) && port.listUpcomingAgenda) {
    const reste = message.replace(/[ée]ch[ée]ances?|rendez-vous|[ée]v[ée]nements?|rappels?|bient[ôo]t|arrivent|prochaine?s?|[àa] venir/gi, ' ');
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
      : formatList(`Échéances ${fenetre}${scope.label ? ` pour ${scope.label}` : ''}`, rows.map((r) =>
        `« ${r.title} »${r.assetNames.length && !scope.label ? ` (${joinFr(r.assetNames)})` : ''} ${r.forecast ? 'prévue le' : 'le'} ${formatDateFr(r.date)} (${formatRelativeDays(daysBetween(today, r.date))})`), 10)
        + (rows.some((r) => r.forecast) ? ' Les dates « prévues » sont prévisionnelles : elles seront confirmées par un document.' : '');
    const srcs = sources.length ? sources : scope.assets.map(assetSrc);
    return { strategy: 'structured.upcoming_agenda', answer, sources: srcs, claims: [claim('upcoming', answer, srcs, 'calculated')], kind: rows.length ? 'list' : 'no_result' };
  }

  // ── Champ d'un bien (T2-22, T2-23, T2-32) ──────────────────────────────
  const champ = findReadableField(message) ?? purchaseQuestion(message);
  if (champ && isFieldQuestion(message) && port.readAssetField) {
    const reste = plain(message).replace(new RegExp(esc(champ.phrase), 'g'), ' ');
    const scope = await p.resolveScope(reste);
    if (scope.ambiguous) return { ambiguous: scope.assets, reason: 'FIELD_MULTIPLE_ASSETS' };
    if (scope.unresolved || scope.assets.length !== 1) return null;
    const a = scope.assets[0];
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
    if (lignes.length) return lignes.join(' ');
  }
  const valeur = r.key === 'acquisitionDate' && r.display
    ? `Vous avez acheté ${r.assetName ?? 'ce bien'} le ${r.display}.`
    : `${r.label} de ${r.assetName ?? 'ce bien'} : ${r.display}.`;
  const conflit = r.openConflict ? ` Un autre document propose une valeur différente : c’est à arbitrer dans « À traiter » (${r.openConflict.question}).` : '';
  return `${valeur}${conflit}`;
}
