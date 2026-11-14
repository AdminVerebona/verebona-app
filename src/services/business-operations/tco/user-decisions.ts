/**
 * Lot 80A — « Ajouter au TCO » / « Retirer du TCO » : DÉCISION UTILISATEUR
 * sur une ligne du coût de possession. PUR (aucun accès base), appliqué par
 * `computeTco` AVANT les totaux : TCO total, TCO moyen annuel, dépenses de
 * l'année (76G, dérivées des mêmes lignes) et T2 (`t2CostExclusions`)
 * reflètent la décision.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CLÉ STABLE D'UNE LIGNE (`tcoLineKeys`)
 *
 * Les identifiants techniques ne survivent pas aux reconsolidations : une
 * composante modifiée est SUPERSÉDÉE (nouvel identifiant), une Opération peut
 * être fusionnée ou invalidée (78A), un candidat T1 change à chaque analyse.
 * La décision est donc rattachée au FAIT, désigné par son justificatif :
 *
 *   f:<fichier>:<nature>:<montant mineur>:<devise>
 *     · ligne documentaire : son fichier ;
 *     · composante d'Opération : SES justificatifs (provenance 78B) — clé
 *       principale sur le justificatif affiché, clés secondaires sur les
 *       autres. Une dépense comptée d'abord par son justificatif puis reprise
 *       par T3 (composante citant ce justificatif) garde donc la même clé : la
 *       décision survit à la consolidation et aux reconsolidations ;
 *   s:<source>:<nature>:<montant>:<devise> — lot 85A (O-9) : composante SANS
 *     justificatif portée par une source reproductible (donnée structurée du
 *     bien / de l'équipement, élément d'agenda — `tcoSourceIdentity`) : la
 *     clé survit à la reconstruction des Opérations (O-2) ; `o:` en clé
 *     secondaire (décisions antérieures) ;
 *   o:<Opération>:<nature>:<montant>:<devise> — composante SANS justificatif
 *     ni source reproductible (sinistre saisi…) : l'Opération est l'identité
 *     la plus stable (la reconstruction O-2 CONSERVE ces Opérations) ;
 *   asset:<bien>:acquisitionPrice / equipment:<équipement>:acquisitionPrice —
 *     prix d'achat de la fiche (identifiants stables).
 * Le montant fait partie de la clé : un montant corrigé est un autre fait (la
 * décision ne s'y applique plus ; elle reste journalisée et visible au BO).
 *
 * APPLICATION (priorité sur les règles automatiques, pour CETTE ligne)
 *   · décision appliquée aux lignes dont c'est la clé PRINCIPALE, sinon (aucune)
 *     à celles dont c'est une clé secondaire (transition justificatif → T3) ;
 *     lot 85A (O-9) : aussi à celles-ci quand aucune ligne de la clé principale
 *     n'est retenue et qu'une ligne secondaire l'est (le fait a changé de ligne :
 *     justificatif ou prix de la fiche repris par une Opération) ;
 *   · plusieurs décisions sur une même ligne : la plus récente l'emporte ;
 *   · RETIRER : toute ligne retenue visée sort du total (motif USER_EXCLUDED) ;
 *   · AJOUTER : si le fait est déjà retenu par une ligne visée, rien ne change ;
 *     sinon UNE SEULE ligne visée est comptée (jamais deux fois le même fait
 *     par une même décision), à son montant en euros ; une prévision ajoutée
 *     est comptée comme une dépense réalisée ;
 *   · jamais ajoutable : montant inconnu, devise sans contre-valeur, autre
 *     bien, ligne déjà portée par une autre dépense, document qui n'est pas
 *     une dépense (règlement, capital, prix de vente) ; lot 81D : dépense non
 *     réalisée (prévue, ou datée après la date de référence) ;
 *   · doublon présumé (`tcoAddDuplicateRisk`) : la confirmation l'annonce
 *     explicitement (refus serveur sans confirmation), la ligne ajoutée reste
 *     signalée (USER_INCLUDED_DUPLICATES) — jamais un double comptage à
 *     l'insu de l'utilisateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { COMPONENT_EFFECT, componentEurMinor, EXCLUSION_LABELS, ledgerKey, type LedgerEntry } from '../finance/engine';
import { DOCUMENT_LINE_REASON_LABELS, type EconomicLineReason, type EconomicLineStatus } from '../finance/economic-lines';
import type { TcoCategory, TcoEconomicLine, TcoWarning } from './model';

/**
 * Lot 80A : INCLUDE (« Ajouter au TCO ») / EXCLUDE (« Retirer du TCO »).
 * Lot 111V (ticket « TCO — anomalies corrigeables ») : ARBITRAGES explicites,
 * qui CLÔTURENT un point à vérifier (jamais INCLUDE / EXCLUDE détournés) :
 *   · CONFIRM_EXCLUSION — la ligne non retenue doit le rester (ce n'est pas une
 *     dépense de ce bien, aucune dépense sur ce document) : total inchangé ;
 *   · SAME_FACT — cette source représente le même fait qu'une dépense déjà
 *     comptée : une seule contribution, les deux justificatifs restent ;
 *   · DISTINCT_FACTS — deux transactions / échéances différentes (même montant
 *     possible) : chacune compte, sans double comptage interne ;
 *   · REQUALIFY — nature confirmée : dépense de ce bien (catégorie choisie),
 *     comptée à son montant en euros (jamais un montant inventé).
 */
export type TcoUserDecisionValue = 'INCLUDE' | 'EXCLUDE' | 'CONFIRM_EXCLUSION' | 'SAME_FACT' | 'DISTINCT_FACTS' | 'REQUALIFY';

/**
 * Lot 111V : catégories qu'un utilisateur peut choisir en confirmant la nature d'une dépense — jamais
 * l'acquisition du bien (chantier 111S), le financement (111F) ni la cession (fiche du bien).
 */
export const TCO_REQUALIFY_CATEGORIES: readonly TcoCategory[] = ['USAGE', 'MAINTENANCE', 'CONTRACTS', 'ACCESSORIES', 'CLAIMS', 'OTHER'];

/** Lot 111V : arbitrages (clôturent un point à vérifier ; annulables par « Annuler mon choix »). */
export const TCO_ARBITRATION_DECISIONS: ReadonlySet<TcoUserDecisionValue> = new Set(['CONFIRM_EXCLUSION', 'SAME_FACT', 'DISTINCT_FACTS', 'REQUALIFY']);
/** Lot 111V : décisions dont le résultat voulu est « la ligne compte » (T2 la compte aussi). */
export const TCO_COUNTING_DECISIONS: ReadonlySet<TcoUserDecisionValue> = new Set(['INCLUDE', 'DISTINCT_FACTS', 'REQUALIFY']);

/**
 * Lot 113N (carte #712 « TCO — confirmer une dépense conservée sans date ») — décision TYPÉE sur la DATE
 * d'une dépense RETENUE, DISTINCTE de l'inclusion / exclusion (colonnes propres `date_decision` de la
 * migration 1515, même clé stable de ligne) :
 *   · CONFIRM_UNDATED — « je conserve cette dépense sans date économique établie » : montant, rattachement,
 *     total et ventilation inchangés (aucune année artificielle) ; ne clôt QUE le point
 *     `ECONOMIC_DATE_UNDETERMINED` de cette ligne, jamais un autre constat (doublon, montant, bien…).
 * Elle ne remplace ni n'écrase jamais une décision INCLUDE / EXCLUDE / arbitrage portée par la même clé.
 */
export type TcoDateDecisionValue = 'CONFIRM_UNDATED';

/** Lot 113N : confirmation persistée (clé stable de la ligne, auteur, horodatage). */
export interface TcoUndatedConfirmation {
  key: string;
  confirmedAt: string;
  confirmedByUserId: number | null;
  /**
   * Carte #769 : identifiant technique de la ligne au moment du choix (`line_id` de la table). Sert UNIQUEMENT à
   * départager une clé devenue commune à plusieurs dépenses (jamais à étendre une confirmation).
   */
  lineId?: string | null;
}

/** Carte #769 : confirmation dont la clé désigne plusieurs dépenses distinctes — jamais appliquée, à arbitrer. */
export interface TcoAmbiguousUndatedConfirmation {
  confirmation: TcoUndatedConfirmation;
  /** Dépenses retenues sans date que la clé désigne indistinctement. */
  lineIds: string[];
}

/** Lot 113N : dépense RETENUE dont la date économique n'est pas établie (comptée, rattachée à aucune année). */
export function tcoLineUndated(l: Pick<TcoEconomicLine, 'status' | 'date'> & Partial<Pick<TcoEconomicLine, 'economicDate' | 'undated'>>): boolean {
  return RETENUE(l.status) && !l.date && (l.undated === true || l.economicDate?.status === 'UNDETERMINED');
}

/** Décision persistée (table `asset_cost_line_decisions`, migration 0623, étendue 1320). */
export interface TcoUserDecision {
  key: string;
  decision: TcoUserDecisionValue;
  decidedAt: string;
  decidedByUserId: number | null;
  /** Lot 111V : autres lignes du même arbitrage (doublon : la ligne comptée à sa place). */
  relatedKeys?: readonly string[];
  /** Lot 111V : catégorie choisie par l'utilisateur (REQUALIFY). */
  requalifiedCategory?: TcoCategory | null;
  /** Lot 111V : statut / motif automatiques au moment de la décision (réouverture motivée si une preuve nouvelle les contredit). */
  basisStatus?: EconomicLineStatus | null;
  basisReason?: string | null;
}

/** Décision portée par une ligne (trace : statut et motif automatiques qu'elle remplace). */
export interface TcoLineUserDecision {
  key: string;
  decision: TcoUserDecisionValue;
  decidedAt: string;
  decidedByUserId: number | null;
  /** La décision change le résultat de la ligne (faux : les règles automatiques donnaient déjà ce résultat). */
  applied: boolean;
  automaticStatus: EconomicLineStatus;
  automaticReason: EconomicLineReason | null;
  /**
   * Lot 111V : une preuve nouvelle contredit le choix (le traitement automatique a changé depuis, en sens
   * contraire) — le choix reste appliqué (jamais effacé en silence), le point est rouvert avec son motif.
   */
  contradicted?: boolean;
  relatedKeys?: readonly string[];
}

const RETENUE = (s: EconomicLineStatus) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';

type KeyLine = Pick<TcoEconomicLine, 'id' | 'source' | 'kind' | 'amountMinor' | 'currency' | 'fileId' | 'sourceFileIds' | 'operationId' | 'sourceIdentities'>
  & Partial<Pick<TcoEconomicLine, 'mergedFacts'>>;

/**
 * Lot 85A (O-9) — natures de sources non documentaires dont l'identité
 * survit à la reconstruction des Opérations (O-2) : la donnée structurée du
 * bien ou de l'équipement (par nature d'Opération) et l'élément d'agenda
 * (saisie de l'utilisateur) sont des SOURCES conservées (CDC v5 §20.2), l'une
 * comme l'autre reconsolidées en Opération par T3. Les autres natures
 * (ancien formulaire Sinistre, arbitrage utilisateur, reprise) appartiennent à
 * des Opérations que la reconstruction CONSERVE : leur clé `o:` reste valable.
 */
export const TCO_STABLE_SOURCE_KINDS: ReadonlySet<string> = new Set(['ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA']);

/** Identité stable d'une source (pure) : `<nature>:<entité>[:<nature d'Opération>]`, null si non reproductible. */
export function tcoSourceIdentity(kind: string, entityKey: string, nature: string | null | undefined): string | null {
  if (!TCO_STABLE_SOURCE_KINDS.has(kind) || !entityKey) return null;
  return `${kind}:${entityKey}${nature ? `:${nature}` : ''}`;
}

/** Clés stables d'une ligne : principale et secondaires (pure). */
export function tcoLineKeys(l: KeyLine): { primary: string; secondary: string[] } {
  if (l.source === 'ASSET_DATA' || l.source === 'EQUIPMENT_DATA') return { primary: l.id, secondary: [] };
  const fait = `${l.kind ?? 'NONE'}:${l.amountMinor}:${String(l.currency ?? '').trim().toUpperCase()}`;
  let fichiers: number[];
  if (l.source === 'OPERATION') {
    // Provenance lue : SES justificatifs seulement (jamais le justificatif principal d'une autre transaction).
    fichiers = l.sourceFileIds ? [...new Set(l.sourceFileIds)] : l.fileId != null ? [l.fileId] : [];
    if (!fichiers.length) {
      // Lot 85A (O-9) : composante sans justificatif portée par une source REPRODUCTIBLE (fiche, équipement,
      // agenda) — clé sur cette source, qui survit à la reconstruction des Opérations ; l'ancienne clé `o:`
      // reste SECONDAIRE (décisions prises avant ce lot toujours appliquées, jamais perdues).
      const ids = [...new Set(l.sourceIdentities ?? [])].sort();
      const legacy = `o:${l.operationId ?? 0}:${fait}`;
      if (!ids.length) return { primary: legacy, secondary: [] };
      // Prix d'achat de la fiche repris par T3 (Opération d'acquisition issue de la donnée structurée) : la
      // décision prise sur la ligne de la fiche (`asset:<bien>:acquisitionPrice`) suit le même fait.
      const fiche = l.kind === 'REALIZED_COST'
        ? ids.map((x) => /^ASSET_DATA:(\d+):ACQUISITION$/.exec(x)).filter((m): m is RegExpExecArray => !!m).map((m) => `asset:${m[1]}:acquisitionPrice`) : [];
      return { primary: `s:${ids[0]}:${fait}`, secondary: [...ids.slice(1).map((x) => `s:${x}:${fait}`), legacy, ...fiche] };
    }
  } else fichiers = l.fileId != null ? [l.fileId] : [];
  if (!fichiers.length) return { primary: l.id, secondary: [] };
  const principal = l.fileId != null && fichiers.includes(l.fileId) ? l.fileId : [...fichiers].sort((a, b) => a - b)[0];
  // Lot 109D : net d'un achat recomposé — une décision prise sur l'une de ses anciennes lignes de coût le suit.
  const reunis = (l.mergedFacts ?? []).map((m) => `f:${principal}:${m.kind}:${m.amountMinor}:${String(m.currency ?? '').trim().toUpperCase()}`);
  return {
    primary: `f:${principal}:${fait}`,
    secondary: [...fichiers.filter((f) => f !== principal).sort((a, b) => a - b).map((f) => `f:${f}:${fait}`), ...reunis.filter((k) => k !== `f:${principal}:${fait}`)],
  };
}

/*
 * ══════════════════════════════════════════════════════════════════════════
 * Carte #769 — IDENTITÉ DU FAIT ÉCONOMIQUE INDIVIDUEL (`factKey`)
 *
 * La clé ci-dessus (`tcoLineKeys`) désigne un fait par son justificatif, sa
 * nature, son montant et sa devise. Elle ne distingue PAS deux dépenses
 * réelles de même nature et de même montant portées par le même justificatif
 * (deux échéances d'un même contrat, deux périodes) : le moteur les compte
 * toutes les deux, la clé est commune. Une confirmation « sans date » ne doit
 * porter que sur UNE dépense.
 *
 *   · clé non partagée (cas général) : `factKey` = clé principale, inchangée
 *     (aucune donnée existante à reprendre) ;
 *   · clé partagée par plusieurs dépenses RETENUES (toutes comptées par le
 *     moteur : ce sont des faits distincts) :
 *       `<clé>#p:<début>~<fin>`  la période qualifiée de la dépense, quand
 *                                elle la distingue des autres (identité
 *                                durable : survit aux reconsolidations) ;
 *       `<clé>#l:<ligne>`        sinon, la ligne elle-même (aucune propriété
 *                                durable ne distingue ces dépenses : si la
 *                                ligne est remplacée, la confirmation devient
 *                                ambiguë — signalée, jamais étendue).
 * Le montant seul, le justificatif seul ou la période seule ne prouvent
 * jamais le même fait : la période ne sert qu'à DISTINGUER deux dépenses
 * d'une même clé, jamais à en réunir deux.
 * ══════════════════════════════════════════════════════════════════════════
 */
type FactLine = KeyLine & Pick<TcoEconomicLine, 'status'> & Partial<Pick<TcoEconomicLine, 'period'>>;

const jourIso = (d: string | null | undefined): string | null => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
/** Période QUALIFIÉE d'une ligne (`début~fin`), null si aucune borne n'est établie. */
const periodeDe = (l: Partial<Pick<TcoEconomicLine, 'period'>>): string | null => {
  const [a, b] = [jourIso(l.period?.start), jourIso(l.period?.end)];
  return a || b ? `${a ?? ''}~${b ?? ''}` : null;
};

/** Décompose une clé de fait : clé de base et discriminant (période ou ligne). */
export function parseTcoFactKey(key: string): { base: string; period: string | null; lineId: string | null } {
  const i = key.indexOf('#');
  if (i < 0) return { base: key, period: null, lineId: null };
  const suffixe = key.slice(i + 1);
  return {
    base: key.slice(0, i),
    period: suffixe.startsWith('p:') ? suffixe.slice(2) : null,
    lineId: suffixe.startsWith('l:') ? suffixe.slice(2) : null,
  };
}

/**
 * Carte #769 : clé du FAIT INDIVIDUEL de chaque ligne (pure) — voir le bloc ci-dessus. Rend, par identifiant de
 * ligne, la clé de fait ; les lignes non retenues gardent leur clé principale (représentations d'un fait compté
 * ailleurs, ou dépenses non comptées : jamais confirmables « sans date »).
 */
export function tcoFactKeys(lines: readonly FactLine[]): Map<string, string> {
  const out = new Map<string, string>();
  const groupes = new Map<string, FactLine[]>();
  for (const l of lines) {
    const k = tcoLineKeys(l).primary;
    out.set(l.id, k);
    if (!RETENUE(l.status)) continue;
    groupes.set(k, [...(groupes.get(k) ?? []), l]);
  }
  for (const [k, g] of groupes) {
    if (g.length < 2) continue;
    const periodes = g.map(periodeDe);
    g.forEach((l, i) => {
      const p = periodes[i];
      const distinctive = p != null && periodes.filter((x) => x === p).length === 1;
      out.set(l.id, distinctive ? `${k}#p:${p}` : `${k}#l:${l.id}`);
    });
  }
  return out;
}

/** FNV-1a 32 bits (pur, sans dépendance : ce module est aussi chargé par l'interface). */
const fnv = (s: string, seed: number): string => {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};

/**
 * Carte #769 (écart D) — VERSION des propriétés matérielles d'une ligne (pure) : nature, montant, devise,
 * période qualifiée, date économique (ou son absence), contre-valeur en euros et traitement AUTOMATIQUE
 * (retenue ou motif d'écart). Une décision reçue avec une autre version porte sur une dépense qui a changé
 * depuis l'affichage : refusée (`DECISION_STALE`). N'entrent PAS dans la version : l'identifiant technique, la
 * source (justificatif repris par un événement de référence : re-clé prouvée par les clés secondaires), le
 * libellé, ni les choix de l'utilisateur (une requête répétée à l'identique reste idempotente).
 */
export function tcoLineVersion(
  l: Pick<TcoEconomicLine, 'kind' | 'amountMinor' | 'currency' | 'status' | 'date' | 'eurCents'> & Partial<Pick<TcoEconomicLine, 'period' | 'undated' | 'userDecision' | 'economicDate' | 'amountUnknown'>>,
): string {
  const statut = l.userDecision?.applied ? l.userDecision.automaticStatus : l.status;
  const canon = [
    l.kind ?? '', l.amountMinor, String(l.currency ?? '').trim().toUpperCase(), periodeDe(l) ?? '',
    RETENUE(statut) ? 'R' : statut, jourIso(l.date) ?? '', !l.date && (l.undated === true || l.economicDate?.status === 'UNDETERMINED') ? 'U' : '',
    // Contre-valeur par la conversion du moteur (identique avant et après un ajout par l'utilisateur).
    tcoLineEurCents({ eurCents: l.eurCents, amountMinor: l.amountMinor, currency: l.currency, amountUnknown: l.amountUnknown }) ?? '',
  ].join('|');
  return `v1:${fnv(canon, 0x811c9dc5)}${fnv(canon, 0x01234567)}`;
}

/** Une ligne retenue peut-elle être retirée ? (le prix de cession n'est pas une dépense). */
export function tcoLineRemovable(l: Pick<TcoEconomicLine, 'status' | 'kind'>): boolean {
  return RETENUE(l.status) && l.kind !== 'PROCEED';
}

/**
 * Lot 111V : motif RÉEL d'un ajout impossible (code stable) — classification, montant, conversion et
 * réalisation sont distingués ; « devise étrangère » seulement si la devise d'origine n'est pas l'euro.
 */
export type TcoAddBlockedCode =
  | 'ALREADY_RETAINED' | 'NOT_REALIZED' | 'AMOUNT_MISSING' | 'OTHER_ASSET' | 'COUNTED_ELSEWHERE'
  | 'NOT_AN_EXPENSE' | 'NATURE_TO_CONFIRM' | 'FOREIGN_CURRENCY';

type AddableLine = Pick<TcoEconomicLine, 'status' | 'kind' | 'eurCents' | 'amountUnknown' | 'notRealized'> & Partial<Pick<TcoEconomicLine, 'reason' | 'currency' | 'amountMinor'>>;

const devise = (c: string | null | undefined) => String(c ?? '').trim().toUpperCase();
/** Devise d'origine AVÉRÉE autre que l'euro (une devise absente n'est jamais « étrangère »). */
const deviseEtrangere = (c: string | null | undefined) => { const d = devise(c); return !!d && d !== 'EUR'; };

/** Lot 111V : montant en euros d'une ligne, y compris non qualifiée (même conversion que le moteur ; null : inconnu ou non convertible). */
export function tcoLineEurCents(l: Pick<TcoEconomicLine, 'eurCents' | 'amountMinor' | 'currency'> & Partial<Pick<TcoEconomicLine, 'amountUnknown'>>): number | null {
  if (l.amountUnknown) return null;
  if (l.eurCents != null) return l.eurCents;
  if (!(l.amountMinor > 0) || !devise(l.currency)) return null;
  return componentEurMinor({ amountMinor: l.amountMinor, currency: devise(l.currency), amountEurCents: null });
}

/** Une ligne non retenue peut-elle être ajoutée ? Motif en langage utilisateur sinon (pure). */
export function tcoLineAddable(l: AddableLine): { ok: true } | { ok: false; reason: string; code: TcoAddBlockedCode } {
  if (RETENUE(l.status)) return { ok: false, code: 'ALREADY_RETAINED', reason: 'Déjà retenue dans le coût de possession.' };
  // Lot 81D : une dépense non réalisée ne contribue à aucun indicateur, même sur décision (jamais de date de réalisation inventée).
  if (l.notRealized) return { ok: false, code: 'NOT_REALIZED', reason: 'Dépense non encore réalisée : elle ne peut être comptée qu’une fois réalisée (paiement daté et justifié).' };
  if (l.amountUnknown) return { ok: false, code: 'AMOUNT_MISSING', reason: 'Montant à renseigner : aucun montant n’a pu être lu sur le justificatif. Indiquez-le sur le document pour qu’il soit compté.' };
  if (l.status === 'OUT_OF_SCOPE') return { ok: false, code: 'OTHER_ASSET', reason: 'Dépense attribuée à un autre bien.' };
  if (l.status === 'CONSOLIDATED_ELSEWHERE') return { ok: false, code: 'COUNTED_ELSEWHERE', reason: 'Déjà comptée par une autre dépense : utilisez la dépense qui la porte.' };
  // Règlement, capital emprunté, prix de vente : jamais une dépense (motif établi par le moteur).
  if (l.kind === 'PROCEED' || l.status === 'PAYMENT' || l.reason === 'PAYMENT_PROOF' || l.reason === 'LOAN_PRINCIPAL') {
    return { ok: false, code: 'NOT_AN_EXPENSE', reason: 'Ce document n’est pas une dépense (règlement, capital emprunté ou prix de vente).' };
  }
  // Lot 111V : nature non établie (document non classé comme dépense) — à confirmer, jamais une « devise étrangère ».
  if (!l.kind) return { ok: false, code: 'NATURE_TO_CONFIRM', reason: 'Nature de la dépense à confirmer : indiquez s’il s’agit d’une dépense de ce bien.' };
  if (l.status === 'UNCONVERTED' || (l.eurCents == null && deviseEtrangere(l.currency))) {
    return { ok: false, code: 'FOREIGN_CURRENCY', reason: 'Montant en devise étrangère sans contre-valeur en euros : indiquez le montant en euros sur le document pour pouvoir l’ajouter.' };
  }
  if (l.eurCents == null) return { ok: false, code: 'AMOUNT_MISSING', reason: 'Montant à renseigner : indiquez le montant sur le document pour qu’il soit compté.' };
  return { ok: true };
}

/** Lot 111V : ligne dont la nature peut être confirmée par l'utilisateur (« C'est une dépense de ce bien »). */
export function tcoLineRequalifiable(l: AddableLine & Pick<TcoEconomicLine, 'amountMinor' | 'currency'>): boolean {
  if (RETENUE(l.status) || l.notRealized || l.amountUnknown) return false;
  if (!['EXCLUDED', 'NOT_QUALIFIED'].includes(l.status)) return false;
  const a = tcoLineAddable(l);
  if (a.ok || a.code !== 'NATURE_TO_CONFIRM') return false;
  return tcoLineEurCents({ eurCents: l.eurCents, amountMinor: l.amountMinor ?? 0, currency: l.currency ?? '' }) != null;
}

/** Motifs pour lesquels le moteur considère la ligne comme DÉJÀ comptée ailleurs. */
const DEJA_COMPTEE: ReadonlySet<string> = new Set([
  'SAME_FACT_OTHER_DOCUMENT', 'SAME_AS_ASSET_PRICE', 'SAME_AS_EQUIPMENT_DOCUMENT', 'DUPLICATE_COPY', 'DUPLICATE_REFERENCE',
  'COVERED_BY_OPERATION', 'SOURCE_WITHDRAWN', 'INCLUDED_IN_OPERATION_TOTAL', 'INCLUDED_IN_TOTAL_SAME_DOCUMENT', 'INCLUDED_IN_TOTAL_INVOICE',
  'ASSET_PRICE_CONSOLIDATED', 'EQUIPMENT_PRICE_CONSOLIDATED',
  // Lot 108A : même achat confirmé représenté par une autre source (fiche, justificatif, événement de référence).
  'SAME_FACT_CROSS_SOURCE',
  // Lot 111V : même fait confirmé par l'utilisateur.
  'USER_SAME_FACT',
  // Lot 113AL : autre source d'un fait déjà compté, établie par l'arbitrage T3 validé.
  'SEMANTIC_SAME_FACT',
]);
const REASON_LABELS: Readonly<Record<string, string>> = { ...EXCLUSION_LABELS, ...DOCUMENT_LINE_REASON_LABELS };

const dateFr = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : 'sans date');

/**
 * Ajouter cette ligne crée-t-il un doublon présumé ? Message explicite pour la
 * confirmation, ou null (pure). Même montant qu'une dépense déjà retenue, ou
 * ligne que le moteur considère déjà comptée (doublon, copie, montant compris
 * dans un total, justificatif repris).
 */
export function tcoAddDuplicateRisk(
  l: Pick<TcoEconomicLine, 'id' | 'status' | 'reason' | 'eurCents' | 'kind'>,
  lines: ReadonlyArray<Pick<TcoEconomicLine, 'id' | 'status' | 'eurCents' | 'kind' | 'label' | 'date'>>,
): string | null {
  if (l.status === 'DUPLICATE' || l.status === 'INCLUDED_IN_TOTAL' || (l.reason && DEJA_COMPTEE.has(l.reason))) {
    const motif = l.reason ? REASON_LABELS[l.reason] : null;
    return `Doublon présumé : Verebona considère ce montant comme déjà compté${motif ? ` (${motif.charAt(0).toLowerCase()}${motif.slice(1)})` : ''}. L’ajouter peut compter deux fois la même dépense.`;
  }
  const kind = l.kind === 'FORECAST_COST' ? 'REALIZED_COST' : l.kind;
  const meme = l.eurCents != null ? lines.find((o) => o.id !== l.id && RETENUE(o.status) && o.eurCents === l.eurCents && o.kind === kind) : undefined;
  if (meme) {
    return `Doublon présumé : une dépense déjà retenue porte le même montant (« ${meme.label} », ${dateFr(meme.date)}). Vérifiez qu’il ne s’agit pas du même paiement avant de l’ajouter.`;
  }
  return null;
}

/**
 * Lot 111V — GESTES CONTEXTUELS d'une ligne (pure, calculés côté serveur,
 * jamais par l'interface) : chaque cas « À corriger / À revoir » a une issue
 * réalisable, adaptée à son motif réel (jamais un « Ajouter » universel).
 *   · EDIT_DOCUMENT : ouvrir le justificatif pour corriger montant, devise,
 *     date ou bien concerné (formulaire existant du document) ;
 *   · REVERT : annuler un arbitrage (retour au traitement automatique).
 */
export type TcoDecisionOptionAction = TcoUserDecisionValue | 'REVERT' | 'EDIT_DOCUMENT'
  // Lot 113N : confirmation « sans date » (et son annulation), saisie de la date dans le champ de la fiche du bien.
  | TcoDateDecisionValue | 'REVERT_UNDATED' | 'EDIT_ASSET_FIELD';

/** Lot 113N : gestes envoyés au serveur (les autres ouvrent un formulaire existant). */
export type TcoDecisionSubmitAction = Exclude<TcoDecisionOptionAction, 'EDIT_DOCUMENT' | 'EDIT_ASSET_FIELD'>;

/** Lot 113N : gestes relatifs à la DATE d'une dépense retenue (point `ECONOMIC_DATE_UNDETERMINED` seulement). */
export const TCO_DATE_ACTIONS: ReadonlySet<TcoDecisionOptionAction> = new Set(['CONFIRM_UNDATED', 'REVERT_UNDATED']);

export interface TcoDecisionOption {
  action: TcoDecisionOptionAction;
  label: string;
  /** Phrase de confirmation (effet exact du geste sur le coût de possession). */
  confirm: string;
  /** REQUALIFY : l'utilisateur choisit la catégorie (proposée : celle de la ligne). */
  needsCategory?: boolean;
  /** INCLUDE : avertissement de doublon présumé (confirmation explicite exigée). */
  duplicateWarning?: string | null;
  /** EDIT_DOCUMENT : justificatif à ouvrir. */
  fileId?: number | null;
  /** Lot 113N : EDIT_ASSET_FIELD — champ de la fiche du bien à renseigner. */
  field?: 'acquisitionDate';
  /** Lot 113N : geste de saisie de la DATE de la dépense (« Renseigner la date »). */
  dateEntry?: true;
}

/** Lot 113N : textes des gestes « sans date » (libellés du ticket repris à l'identique). */
export const TCO_UNDATED_LABELS = {
  confirm: 'Conserver dans le TCO sans date',
  confirmEffect: 'Conserver cette dépense dans le coût de possession sans date : son montant et le total sont inchangés, elle n’est rattachée à aucune année. Le point est clos.',
  enterDate: 'Renseigner la date',
  revert: 'Annuler mon choix',
  revertEffect: 'Annuler votre choix ? La dépense reste comptée ; sa date non établie redevient un point à vérifier.',
  decided: 'Conservée sans date, confirmé par vous.',
} as const;

/**
 * Lot 113N : gestes de la DATE d'une dépense retenue non datée (pure) — confirmer la conservation sans date
 * (ou l'annuler), et « Renseigner la date » seulement si le moteur a établi où la date de CETTE dépense se
 * saisit (`dateEntry` : champ de la fiche, date du justificatif qui établit le montant) ; jamais une date
 * d'échéance ou de document qui ne prouve pas la dépense.
 */
function tcoUndatedOptions(l: OptionLine): TcoDecisionOption[] {
  if (!tcoLineUndated(l)) return [];
  if (l.undatedConfirmation) return [{ action: 'REVERT_UNDATED', label: TCO_UNDATED_LABELS.revert, confirm: TCO_UNDATED_LABELS.revertEffect }];
  const out: TcoDecisionOption[] = [{ action: 'CONFIRM_UNDATED', label: TCO_UNDATED_LABELS.confirm, confirm: TCO_UNDATED_LABELS.confirmEffect }];
  const e = l.dateEntry;
  if (e?.kind === 'ASSET_FIELD') out.push({ action: 'EDIT_ASSET_FIELD', label: TCO_UNDATED_LABELS.enterDate, confirm: '', field: e.field, dateEntry: true });
  else if (e?.kind === 'DOCUMENT') out.push({ action: 'EDIT_DOCUMENT', label: TCO_UNDATED_LABELS.enterDate, confirm: '', fileId: e.fileId, dateEntry: true });
  return out;
}

type OptionLine = TcoEconomicLine;

/** Ligne présumée doublon d'une autre (même somme, sans preuve d'une transaction distincte). */
export const tcoPresumedDuplicate = (l: Pick<TcoEconomicLine, 'status' | 'reason'>): boolean => l.status === 'DUPLICATE' && l.reason === 'SAME_FACT_OTHER_DOCUMENT';

/** Gestes possibles sur une ligne montrée (pure, testée L111V-U-OPT). */
export function tcoLineDecisionOptions(l: OptionLine, lines: readonly OptionLine[]): TcoDecisionOption[] {
  const out: TcoDecisionOption[] = [];
  const d = l.userDecision;
  // Lot 113N : gestes de la date (indépendants de tout arbitrage porté par la même ligne).
  const dates = tcoUndatedOptions(l);
  if (d && TCO_ARBITRATION_DECISIONS.has(d.decision) && (d.applied || d.contradicted)) {
    if (d.contradicted && d.applied) out.push({ action: d.decision, label: 'Garder mon choix', confirm: 'Confirmer de nouveau votre choix malgré la nouvelle information.' });
    out.push({ action: 'REVERT', label: 'Annuler mon choix', confirm: 'Annuler votre choix ? La ligne retrouve le traitement automatique.' });
    out.push(...dates);
    return out;
  }
  const doc = l.fileId ?? l.sourceFileIds?.[0] ?? null;
  const corriger = (label: string): TcoDecisionOption | null => (doc != null ? { action: 'EDIT_DOCUMENT', label, confirm: '', fileId: doc } : null);
  const push = (o: TcoDecisionOption | null) => { if (o) out.push(o); };
  if (RETENUE(l.status)) {
    if (l.uncertain) {
      out.push({ action: 'SAME_FACT', label: 'C’est la même dépense', confirm: 'Compter une seule fois : cette ligne sort du coût de possession, son justificatif reste consultable.' });
      out.push({ action: 'DISTINCT_FACTS', label: 'Dépenses distinctes', confirm: 'Confirmer qu’il s’agit de deux dépenses différentes : cette ligne reste comptée.' });
    }
    out.push(...dates);
    if (tcoLineRemovable(l)) out.push({ action: 'EXCLUDE', label: 'Retirer du TCO', confirm: 'Retirer cette dépense du coût de possession ? Vous pourrez l’ajouter de nouveau.' });
    return out;
  }
  if (tcoPresumedDuplicate(l)) {
    out.push({ action: 'SAME_FACT', label: 'Confirmer le même fait', confirm: 'Confirmer qu’il s’agit de la même dépense : elle reste comptée une seule fois, les deux justificatifs sont conservés.' });
    if (tcoLineEurCents(l) != null && !l.notRealized) out.push({ action: 'DISTINCT_FACTS', label: 'Dépenses distinctes', confirm: 'Confirmer qu’il s’agit de deux dépenses différentes (autre échéance, autre période) : celle-ci est ajoutée au coût de possession.' });
    return out;
  }
  const a = tcoLineAddable(l);
  if (a.ok) {
    out.push({ action: 'INCLUDE', label: 'Ajouter au TCO', confirm: 'Ajouter cette dépense au coût de possession ? Vous pourrez la retirer de nouveau.', duplicateWarning: tcoAddDuplicateRisk(l, lines) });
    if (l.status === 'NOT_QUALIFIED' || l.status === 'UNCONFIRMED_ASSET' || l.status === 'UNALLOCATED') {
      out.push({ action: 'CONFIRM_EXCLUSION', label: l.status === 'NOT_QUALIFIED' ? 'Pas une dépense du bien' : 'Ne concerne pas ce bien', confirm: 'Confirmer que cette ligne ne doit pas être comptée : le coût est inchangé, le point est clos.' });
    }
    return out;
  }
  switch (a.code) {
    case 'NATURE_TO_CONFIRM':
      if (tcoLineRequalifiable(l)) {
        out.push({ action: 'REQUALIFY', label: 'C’est une dépense du bien', needsCategory: true, confirm: 'Compter cette dépense dans le coût de possession, à son montant en euros (aucun paiement n’est ajouté).' });
        out.push({ action: 'CONFIRM_EXCLUSION', label: 'Pas une dépense du bien', confirm: 'Confirmer que ce document ne porte pas de dépense de ce bien : le coût est inchangé, le point est clos.' });
      }
      push(corriger('Corriger le document'));
      break;
    case 'AMOUNT_MISSING':
      push(corriger('Indiquer le montant'));
      out.push({ action: 'CONFIRM_EXCLUSION', label: 'Aucune dépense sur ce document', confirm: 'Confirmer que ce document ne porte pas de dépense : aucun montant n’est attendu, le point est clos.' });
      break;
    case 'FOREIGN_CURRENCY':
      push(corriger('Indiquer le montant en euros'));
      out.push({ action: 'CONFIRM_EXCLUSION', label: 'Ne pas compter', confirm: 'Confirmer que ce montant ne doit pas être compté : le coût est inchangé, le point est clos.' });
      break;
    default:
      break;
  }
  if (l.status === 'UNALLOCATED') {
    push(corriger('Préciser le bien concerné'));
    out.push({ action: 'CONFIRM_EXCLUSION', label: 'Ne pas compter ici', confirm: 'Confirmer que cette dépense commune n’est pas comptée pour ce bien : le coût est inchangé, le point est clos.' });
  }
  return out;
}

type Entry = LedgerEntry & { category: TcoCategory | null };

/** Lot 111V : motifs d'une identité PROUVÉE par le moteur (copie exacte, même référence, même achat confirmé). */
const PREUVE_MEME_FAIT: ReadonlySet<string> = new Set(['DUPLICATE_COPY', 'DUPLICATE_REFERENCE', 'SAME_FACT_CROSS_SOURCE']);

/**
 * Lot 111V : le traitement automatique a changé depuis la décision, en sens contraire du choix (pure) —
 * le choix reste appliqué, le point est rouvert avec son motif (jamais effacé en silence).
 */
export function tcoDecisionContradicted(d: Pick<TcoUserDecision, 'decision' | 'basisStatus' | 'basisReason'>, current: Pick<TcoEconomicLine, 'status' | 'reason'>): boolean {
  if (!TCO_ARBITRATION_DECISIONS.has(d.decision) || !d.basisStatus) return false;
  const veutCompter = TCO_COUNTING_DECISIONS.has(d.decision);
  if (veutCompter && current.reason && PREUVE_MEME_FAIT.has(current.reason) && current.reason !== d.basisReason) return true;
  return RETENUE(d.basisStatus) === veutCompter && RETENUE(current.status) !== veutCompter;
}

/** Clé sans la nature (`f:<fichier>:*:<montant>:<devise>`) : un arbitrage survit à la requalification de la ligne. */
const sansNature = (k: string): string | null => { const m = /^f:(\d+):[^:]+:(.+)$/.exec(k); return m ? `f:${m[1]}:*:${m[2]}` : null; };

/**
 * Lot 113N — applique les confirmations « conservée sans date » aux lignes (mutation, APRÈS les décisions
 * d'inclusion / exclusion, AVANT les diagnostics). AUCUN effet sur le grand livre : ni montant, ni total, ni
 * année (la ligne reste rattachée à aucune année). Une confirmation ne s'applique qu'à une ligne RETENUE dont
 * la date reste non établie : une ligne datée depuis (preuve nouvelle) ou retirée n'en porte aucune — la
 * confirmation est conservée sans objet, jamais un point rouvert ni une date inventée.
 *
 * Carte #769 (écart A) — UNE confirmation, UN fait. Règle remplacée (carte #769) : la confirmation n'est plus
 * diffusée à toutes les lignes de sa clé. Pose aussi `factKey` et `version` sur chaque ligne. Rattachement,
 * dans l'ordre, parmi les dépenses retenues sans date :
 *   1. la ligne dont la clé de FAIT est exactement la clé confirmée ;
 *   2. sinon les lignes de même clé de base en clé principale ; 3. sinon en clé secondaire (fait repris par
 *      un événement de référence — consolidation T3) ; 4. sinon même justificatif et même montant (nature
 *      requalifiée) — jamais une ligne dont la période qualifiée diffère de celle de la confirmation.
 * Une seule dépense désignée : confirmée (représentation prouvée par l'unicité). Plusieurs : départagées par
 * la ligne décidée à l'origine (`lineId`) si elle existe encore ; sinon AMBIGUË — aucune dépense n'est
 * acquittée, la confirmation reste en base (traçable) et est rendue dans `ambiguous` (arbitrage ciblé :
 * chaque dépense concernée redevient « à confirmer »).
 */
export function applyTcoUndatedConfirmations(
  lines: TcoEconomicLine[], confirmations: readonly TcoUndatedConfirmation[],
): { applied: number; orphans: TcoUndatedConfirmation[]; ambiguous: TcoAmbiguousUndatedConfirmation[] } {
  const orphans: TcoUndatedConfirmation[] = [];
  const ambiguous: TcoAmbiguousUndatedConfirmation[] = [];
  const faits = tcoFactKeys(lines);
  const index = (m: Map<string, TcoEconomicLine[]>, k: string, l: TcoEconomicLine) => m.set(k, [...(m.get(k) ?? []), l]);
  const parFait = new Map<string, TcoEconomicLine[]>();
  const parPrincipale = new Map<string, TcoEconomicLine[]>();
  const parSecondaire = new Map<string, TcoEconomicLine[]>();
  const parSansNature = new Map<string, TcoEconomicLine[]>();
  for (const l of lines) {
    const k = tcoLineKeys(l);
    l.factKey = faits.get(l.id) ?? k.primary;
    l.version = tcoLineVersion(l);
    index(parFait, l.factKey, l);
    index(parPrincipale, k.primary, l);
    for (const s of k.secondary) index(parSecondaire, s, l);
    const a = sansNature(k.primary);
    if (a) index(parSansNature, a, l);
  }
  if (!confirmations.length) return { applied: 0, orphans, ambiguous };
  let applied = 0;
  const sansDate = (ls: readonly TcoEconomicLine[] | undefined) => (ls ?? []).filter((l) => tcoLineUndated(l));
  const ordre = [...confirmations].sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt) || a.key.localeCompare(b.key));
  for (const c of ordre) {
    const cle = parseTcoFactKey(c.key);
    const a = sansNature(cle.base);
    // Une période qualifiée différente prouve une AUTRE dépense : jamais la cible d'une confirmation de période.
    const compatibles = (ls: readonly TcoEconomicLine[]) => (cle.period == null ? [...ls] : ls.filter((l) => { const p = periodeDe(l); return p == null || p === cle.period; }));
    let cibles = sansDate(parFait.get(c.key));
    if (!cibles.length) cibles = compatibles(sansDate(parPrincipale.get(cle.base)));
    if (!cibles.length) cibles = compatibles(sansDate(parSecondaire.get(cle.base)));
    if (!cibles.length && a && !parPrincipale.has(cle.base) && !parSecondaire.has(cle.base)) cibles = compatibles(sansDate(parSansNature.get(a)));
    if (!cibles.length) {
      if (!parFait.has(c.key) && !parPrincipale.has(cle.base) && !parSecondaire.has(cle.base) && !(a && parSansNature.has(a))) orphans.push(c);
      continue;
    }
    if (cibles.length > 1) {
      // Ligne décidée à l'origine, toujours présente : c'est elle (même enregistrement, même clé) — et elle seule.
      const origine = cle.lineId ?? c.lineId ?? null;
      const exacte = origine ? cibles.filter((l) => l.id === origine) : [];
      if (exacte.length !== 1) { ambiguous.push({ confirmation: c, lineIds: cibles.map((l) => l.id) }); continue; }
      cibles = exacte;
    }
    const l = cibles[0];
    if (l.undatedConfirmation) continue; // déjà confirmée par un choix plus récent : rien à ajouter
    l.undatedConfirmation = { key: c.key, confirmedAt: c.confirmedAt, confirmedByUserId: c.confirmedByUserId };
    applied += 1;
  }
  return { applied, orphans, ambiguous };
}

/**
 * Applique les décisions aux lignes et aux entrées du grand livre (mutation,
 * avant les totaux). Rend le nombre de décisions qui changent un résultat et
 * les décisions sans ligne correspondante (BO).
 */
export function applyTcoUserDecisions(x: {
  lines: TcoEconomicLine[];
  entries: Entry[];
  decisions: readonly TcoUserDecision[];
  /** Catégorie TCO de chaque Opération (ligne d'Opération ajoutée sans catégorie). */
  operationCategory: ReadonlyMap<number, TcoCategory>;
  warnings: Set<TcoWarning>;
}): { applied: number; includedDuplicates: number; orphans: TcoUserDecision[] } {
  const parPrincipale = new Map<string, TcoEconomicLine[]>();
  const parSecondaire = new Map<string, TcoEconomicLine[]>();
  const parSansNature = new Map<string, TcoEconomicLine[]>();
  for (const l of x.lines) {
    const k = tcoLineKeys(l);
    l.decisionKey = k.primary;
    parPrincipale.set(k.primary, [...(parPrincipale.get(k.primary) ?? []), l]);
    for (const s of k.secondary) parSecondaire.set(s, [...(parSecondaire.get(s) ?? []), l]);
    const a = sansNature(k.primary);
    if (a) parSansNature.set(a, [...(parSansNature.get(a) ?? []), l]);
  }
  const orphans: TcoUserDecision[] = [];
  if (!x.decisions.length) return { applied: 0, includedDuplicates: 0, orphans };
  const entree = new Map<string, Entry>();
  for (const e of x.entries) if (!entree.has(ledgerKey(e))) entree.set(ledgerKey(e), e);
  const incertainesAvant = x.lines.some((l) => RETENUE(l.status) && l.uncertain);
  let applied = 0;
  let includedDuplicates = 0;
  // La plus récente d'abord : une ligne déjà décidée n'est plus touchée (la plus récente l'emporte).
  const ordre = [...x.decisions].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || a.key.localeCompare(b.key));
  const trace = (l: TcoEconomicLine, d: TcoUserDecision, ok: boolean, contradicted = false): void => {
    l.userDecision = {
      key: d.key, decision: d.decision, decidedAt: d.decidedAt, decidedByUserId: d.decidedByUserId, applied: ok, automaticStatus: l.status, automaticReason: l.reason,
      ...(contradicted ? { contradicted: true } : {}), ...(d.relatedKeys?.length ? { relatedKeys: [...d.relatedKeys] } : {}),
    };
  };
  /** Retire une ligne retenue du total (entrée du registre neutralisée). */
  const retirer = (l: TcoEconomicLine, status: TcoEconomicLine['status'], reason: TcoEconomicLine['reason'], note: string): void => {
    const e = entree.get(l.id);
    if (e) { e.included = false; e.includedEurMinor = 0; e.category = null; e.prorata = null; }
    l.status = status; l.reason = reason; l.includedCents = 0;
    delete l.uncertain;
    l.note = note;
  };
  /** Compte UNE ligne non retenue à son montant en euros (jamais deux fois le même fait par une même décision). */
  const compter = (l: TcoEconomicLine, o: { eur: number; kind: NonNullable<TcoEconomicLine['kind']>; category?: TcoCategory | null; note: string }): void => {
    const kind = o.kind;
    const effect = COMPONENT_EFFECT[kind];
    const opCat = l.operationId != null ? x.operationCategory.get(l.operationId) : undefined;
    // Catégorie effacée par la règle automatique (doublon, autre achat) : celle de l'Opération ; un achat ajouté
    // n'est jamais « l'acquisition du bien » (déjà établie ou non) — accessoire / achat complémentaire.
    const repli: TcoCategory = l.source !== 'OPERATION' || !opCat ? 'OTHER' : opCat === 'ACQUISITION' ? 'ACCESSORIES' : opCat;
    const category: TcoCategory | null = effect === 'COST' ? (o.category ?? l.category ?? repli) : null;
    const eur = o.eur;
    const e = entree.get(l.id);
    if (e) Object.assign(e, { kind, effect, included: true, includedEurMinor: eur, eurMinor: eur, exclusion: null, attribution: 'IN', category, prorata: null });
    else {
      const ne: Entry = {
        componentId: l.source === 'OPERATION' && l.id.startsWith('c:') ? Number(l.id.slice(2)) : 0,
        operationId: l.source === 'OPERATION' ? (l.operationId ?? 0) : 0,
        kind, effect, amountMinor: l.amountMinor, currency: l.currency, eurMinor: eur, includedEurMinor: eur, included: true,
        exclusion: null, attribution: 'IN', date: l.date, prorata: null, category,
        ...(l.source === 'OPERATION' && l.id.startsWith('c:') ? {} : { lineId: l.id }),
      };
      x.entries.push(ne);
      entree.set(l.id, ne);
    }
    l.status = l.source === 'OPERATION' ? 'RETAINED_CONSOLIDATED' : 'RETAINED_DIRECT';
    l.reason = null; l.includedCents = eur; l.kind = kind; l.category = category; l.eurCents = eur;
    delete l.uncertain; delete l.duplicateOf;
    l.note = o.note;
  };
  for (const d of ordre) {
    let cibles = (parPrincipale.get(d.key) ?? []).filter((l) => !l.userDecision);
    const secondaires = (parSecondaire.get(d.key) ?? []).filter((l) => !l.userDecision);
    /** Lot 111V : la ligne visée porte désormais le fait via une clé secondaire (sources réunies par T3). */
    const viaSecondaire = (l: TcoEconomicLine) => !(parPrincipale.get(d.key) ?? []).includes(l);
    if (!cibles.length && !parPrincipale.has(d.key)) cibles = secondaires;
    // Lot 85A (O-9) : la ligne de la clé principale existe encore mais ne porte plus le fait (justificatif ou prix de la
    // fiche repris par une Opération, après consolidation ou reconstruction) — la décision suit le fait, porté par la
    // ligne retenue qui le cite en clé secondaire (jamais une décision silencieusement inopérante).
    else if (secondaires.length && !cibles.some((l) => RETENUE(l.status)) && secondaires.some((l) => RETENUE(l.status))) cibles = [...cibles, ...secondaires];
    // Lot 111V : arbitrage sur une ligne dont la NATURE a changé depuis (requalification T1 / T3) — même justificatif, même montant.
    let parNature = false;
    if (!cibles.length && TCO_ARBITRATION_DECISIONS.has(d.decision) && !parPrincipale.has(d.key) && !parSecondaire.has(d.key)) {
      const a = sansNature(d.key);
      cibles = a ? (parSansNature.get(a) ?? []).filter((l) => !l.userDecision) : [];
      parNature = cibles.length > 0;
    }
    if (!cibles.length) { if (!parNature && !parPrincipale.has(d.key) && !parSecondaire.has(d.key)) orphans.push(d); continue; }
    if (d.decision === 'EXCLUDE') {
      for (const l of cibles) {
        const ok = tcoLineRemovable(l);
        trace(l, d, ok);
        if (!ok) continue;
        retirer(l, 'EXCLUDED', 'USER_EXCLUDED', 'Retirée du coût de possession par vous.');
        applied += 1;
      }
      continue;
    }
    if (d.decision === 'CONFIRM_EXCLUSION') {
      // Exclusion confirmée : aucune mutation du total ; une ligne que le traitement automatique compte désormais
      // reste hors du total (le choix prime), signalée « à reconfirmer » (preuve nouvelle).
      for (const l of cibles) {
        // Ligne retenue qui porte le fait par une AUTRE source (T3 a réuni les justificatifs) : jamais retirée en
        // silence — le choix est signalé « à reconfirmer » (preuve nouvelle), le total reste celui du traitement automatique.
        if (RETENUE(l.status) && viaSecondaire(l)) { trace(l, d, false, true); continue; }
        const contredit = tcoDecisionContradicted(d, l);
        trace(l, d, true, contredit);
        if (RETENUE(l.status)) { if (tcoLineRemovable(l)) retirer(l, 'EXCLUDED', 'USER_EXCLUDED', 'Exclusion confirmée par vous.'); }
        else {
          l.note = l.note ? `${l.note} Exclusion confirmée par vous.` : 'Exclusion confirmée par vous.';
          // Montant non converti / commun non ventilé : l'utilisateur l'écarte de ce bien — il ne rend plus le total incomplet.
          const e = entree.get(l.id);
          if (e && (e.exclusion === 'UNCONVERTED_CURRENCY' || e.exclusion === 'UNALLOCATED_MULTI_ASSET')) { e.exclusion = 'OUT_OF_SCOPE'; e.included = false; e.includedEurMinor = 0; }
        }
        applied += 1;
      }
      continue;
    }
    if (d.decision === 'SAME_FACT') {
      for (const l of cibles) {
        // Ligne retenue qui réunit déjà les justificatifs du fait (consolidation T3) : le choix est satisfait, pas contredit.
        const reunie = RETENUE(l.status) && (!l.uncertain || viaSecondaire(l));
        const contredit = !reunie && tcoDecisionContradicted(d, l);
        trace(l, d, true, contredit);
        const note = 'Même dépense qu’une autre déjà comptée, confirmé par vous : comptée une seule fois (le justificatif reste consultable).';
        // Seule une ligne retenue DOUTEUSE (même montant qu'une autre, sans preuve) sort du total ; une ligne retenue qui
        // réunit déjà les deux justificatifs (T3 a consolidé le même fait) EST la contribution unique : rien à retirer.
        if (RETENUE(l.status)) { if (l.uncertain && !viaSecondaire(l) && tcoLineRemovable(l)) retirer(l, 'DUPLICATE', 'USER_SAME_FACT', note); }
        else if (tcoPresumedDuplicate(l)) { l.reason = 'USER_SAME_FACT'; l.note = note; }
        else l.note = note;
        applied += 1;
      }
      continue;
    }
    if (d.decision === 'DISTINCT_FACTS') {
      const l = cibles.find((c) => RETENUE(c.status)) ?? cibles[0];
      for (const c of cibles) if (c !== l) trace(c, d, false);
      const contredit = tcoDecisionContradicted(d, l);
      if (RETENUE(l.status)) {
        // Rapprochement incertain levé : la dépense reste comptée, le doute est clos.
        trace(l, d, true, contredit);
        delete l.uncertain;
        l.note = 'Dépense distincte d’une autre de même montant, confirmé par vous : comptée.';
        applied += 1;
        continue;
      }
      const eur = tcoLineEurCents(l);
      if (eur == null || l.notRealized || !l.kind || l.kind === 'PROCEED') { trace(l, d, false); continue; }
      trace(l, d, true, contredit);
      compter(l, { eur, kind: l.kind === 'FORECAST_COST' ? 'REALIZED_COST' : l.kind, note: 'Dépense distincte d’une autre de même montant, confirmé par vous : comptée.' });
      applied += 1;
      continue;
    }
    if (d.decision === 'REQUALIFY') {
      const l = cibles.find((c) => RETENUE(c.status)) ?? cibles.find((c) => tcoLineRequalifiable(c)) ?? cibles[0];
      for (const c of cibles) if (c !== l) trace(c, d, false);
      if (RETENUE(l.status)) { trace(l, d, false); continue; } // déjà comptée par le traitement automatique
      const eur = tcoLineEurCents(l);
      const qualifiable = eur != null && !l.notRealized && !l.amountUnknown && l.kind !== 'PROCEED' && l.status !== 'PAYMENT'
        && l.status !== 'OUT_OF_SCOPE' && l.status !== 'CONSOLIDATED_ELSEWHERE';
      if (!qualifiable) { trace(l, d, false); continue; }
      trace(l, d, true, tcoDecisionContradicted(d, l));
      compter(l, { eur: eur!, kind: 'REALIZED_COST', category: d.requalifiedCategory ?? null, note: 'Dépense de ce bien, nature confirmée par vous : comptée à son montant en euros.' });
      applied += 1;
      continue;
    }
    // AJOUTER : le fait déjà retenu par une ligne visée → rien à faire ; sinon UNE ligne, la mieux identifiée.
    if (cibles.some((l) => RETENUE(l.status))) { for (const l of cibles) trace(l, d, false); continue; }
    const ajoutables = cibles.filter((l) => tcoLineAddable(l).ok)
      .sort((a, b) => (a.source === 'OPERATION' ? 0 : 1) - (b.source === 'OPERATION' ? 0 : 1) || a.id.localeCompare(b.id));
    const l = ajoutables[0];
    if (!l) { for (const c of cibles) trace(c, d, false); continue; }
    const risque = tcoAddDuplicateRisk(l, x.lines);
    trace(l, d, true);
    compter(l, { eur: l.eurCents!, kind: l.kind === 'FORECAST_COST' ? 'REALIZED_COST' : l.kind!, note: `Ajoutée au coût de possession par vous.${risque ? ` ${risque}` : ''}` });
    if (risque) { includedDuplicates += 1; x.warnings.add('USER_INCLUDED_DUPLICATES'); }
    applied += 1;
  }
  if (applied) {
    x.warnings.add('USER_DECISIONS');
    // Signalements automatiques (78B) qui ne portent plus sur aucune ligne après décision : retirés.
    if (!x.lines.some((l) => tcoPresumedDuplicate(l))) x.warnings.delete('PRESUMED_DUPLICATES');
    if (!x.lines.some((l) => l.reason === 'NOT_OWNERSHIP_COST')) x.warnings.delete('NOT_OWNERSHIP_COSTS');
    // Lot 111V : doutes « même montant » tous levés par l'utilisateur.
    if (incertainesAvant && !x.lines.some((l) => RETENUE(l.status) && l.uncertain)) x.warnings.delete('UNCERTAIN_MATCHES');
  }
  return { applied, includedDuplicates, orphans };
}
