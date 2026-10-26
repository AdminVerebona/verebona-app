/**
 * Clé fonctionnelle, nature et plan de synchronisation d'une source —
 * CDC 15 T4-08, D-14, D-15 (lot 14). Fonctions PURES, sans base.
 *
 * « Implémenter une clé fonctionnelle
 *   sourceFileId + target + businessType + originFieldKey + occurrence
 *   et synchroniser create / update / remove. »
 * Recette : « Échéance 01/03 corrigée en 01/04 → un seul événement au 01/04 ».
 *
 * CLÉ PAR DOCUMENT — choix de conception validé (relecture du lot 14) : la
 * clé inclut le document source. Deux documents qui annoncent la même
 * échéance (facture et carnet, avis d'échéance et contrat) donnent deux clés :
 * la clé ne dédoublonne PAS entre sources. C'est le rapprochement de T4
 * (`findDuplicate`, `dedupe.service` : doublon certain → consolidation,
 * probable → arbitrage) qui protège de ce doublon, AVANT la persistance. La
 * clé, elle, rend la RÉANALYSE d'une même source idempotente et permet de
 * retirer ce qu'elle ne produit plus sans toucher aux autres sources.
 *
 * OCCURRENCE : pour un fait UNIQUE d'une source (champ d'origine connu, pas de
 * série), l'occurrence est `single` — la clé ne dépend pas de la date, et une
 * date corrigée MET À JOUR l'élément. Pour une occurrence de récurrence, ou un
 * événement lu sans champ d'origine, l'occurrence est la DATE (deux dates =
 * deux événements). Deux décisions de même clé dans un même passage prennent
 * un rang (`#2`, `#3`…).
 */
import { createHash } from 'crypto';
import { getField, getEventEntry } from '@/services/canonical/registry';

export type AgendaEventNature = 'HISTORICAL' | 'DEADLINE';

interface FunctionalKeyInput {
  sourceFileId: number;
  target: { type: string; id: number };
  businessType: string | null;
  originFieldKey: string | null;
  /** Date (`AAAA-MM-JJ`) ou rang de l'occurrence. */
  occurrence: string;
}

/** Empreinte stable (40 caractères hexadécimaux, versionnée). */
export function computeAgendaFunctionalKey(p: FunctionalKeyInput): string {
  const brut = [
    'v1', p.sourceFileId, `${p.target.type}:${p.target.id}`, p.businessType ?? '-', p.originFieldKey ?? '-', p.occurrence,
  ].join('|');
  return createHash('sha256').update(brut).digest('hex').slice(0, 40);
}

interface EventSemantics {
  businessType: string | null;
  nature: AgendaEventNature | null;
  /** D-14 : un élément HISTORICAL n'est jamais notifié. */
  notifiable: boolean;
}

/**
 * Type métier et nature d'un événement : explicites s'ils sont fournis
 * (T4 enrichi), sinon déduits du registre (effet agenda du champ d'origine),
 * sinon du catalogue quand le type n'admet qu'une nature (achat, réparation,
 * sinistre, vente → HISTORICAL, D-15). Rien n'est déduit de la seule date.
 */
export function resolveEventSemantics(p: {
  originFieldKey?: string | null;
  businessType?: string | null;
  nature?: AgendaEventNature | null;
}): EventSemantics {
  const effet = p.originFieldKey ? getField(p.originFieldKey)?.agendaEffect : undefined;
  const businessType = p.businessType ?? effet?.businessType ?? null;
  const entree = businessType ? getEventEntry(businessType) : undefined;
  const nature: AgendaEventNature | null = p.nature
    ?? effet?.nature
    ?? (entree && entree.natures.length === 1 ? entree.natures[0] : null);
  const notifiable = nature === 'HISTORICAL' ? false : (nature && entree?.notifiable[nature] === false ? false : true);
  return { businessType: entree?.businessType ?? businessType, nature, notifiable };
}

// ── Plan de synchronisation d'une source (réanalyse) ────────────────────────

/** Décision T4 réduite à ce qui compte pour la synchronisation. */
export interface SyncDecision {
  index: number;
  action: string;
  title: string;
  date: string;
  sourceFileId?: number | null;
  originFieldKey?: string | null;
  existingItemId?: number | null;
  seriesKey?: string | null;
  businessType?: string | null;
  nature?: AgendaEventNature | null;
  /** Index d'occurrence du candidat (`single` ou date) — prime sur la règle par défaut. */
  occurrenceIndex?: string | null;
  /** Cible fine du candidat (équipement, pièce) : fait partie de la clé. */
  target?: { type: string; id: number | null } | null;
  /**
   * Lot 71E (§A) — issue T4 d'un candidat NON créateur (`ignore`) :
   * `reject` (décision explicite : retrait ciblé possible), `abstain` ou
   * `technical_failure` (indéterminé : l'élément rapproché est conservé et
   * aucun retrait global n'a lieu). Absent : décision créatrice ou sans T4.
   */
  t4Outcome?: 'reject' | 'abstain' | 'technical_failure' | null;
  /**
   * Lot 75F (§C) — date NON tranchée (`TEMPORAL_AMBIGUITY`) : décision
   * incomplète pour la synchronisation destructive. Les éléments
   * potentiellement concernés sont conservés et aucun retrait global n'a lieu.
   */
  temporalAmbiguity?: boolean;
}

/** Élément existant de la source, rattaché au bien. */
export interface SourceItem {
  id: number;
  functionalKey: string | null;
  title: string;
  startDate: string | null;
  originFieldKey: string | null;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  manualStatus: string | null;
  /** Lot 75F (§A) — `USER` : prévision confirmée par l'utilisateur (protégée). */
  confirmationMode?: string | null;
}

/** Actions qui CRÉENT un élément et portent donc une clé. */
const KEYED_ACTIONS = new Set(['create', 'propose', 'create_conflict']);

export type SyncStep =
  | { kind: 'create'; index: number; key: string; semantics: EventSemantics }
  | { kind: 'update'; index: number; key: string; itemId: number; semantics: EventSemantics; adopted: boolean }
  | { kind: 'protected'; index: number; key: string; itemId: number }
  /** Lot 75F (§B) — plusieurs éléments existants restent candidats : aucune écriture, tous conservés. */
  | { kind: 'ambiguous'; index: number; key: string; itemIds: number[] };

export interface SourceSyncPlan {
  sourceFileId: number;
  steps: SyncStep[];
  /** Éléments automatiques de la source que plus rien ne produit : retirés. */
  remove: number[];
  /** Éléments conservés (produits, confirmés, ou modifiés à la main). */
  keep: number[];
  /**
   * Lot 71E (§A) — retraits CIBLÉS : éléments automatiques intacts
   * rapprochés de façon FIABLE (même clé, ou même champ d'origine / date /
   * intitulé) d'un candidat que T4 a explicitement REJETÉ. Seuls retraits
   * permis quand une décision reste indéterminée.
   */
  targetedRemove: number[];
  /** Lot 71E (§A) — candidats dont la décision T4 reste indéterminée (abstention, échec technique). */
  undetermined: number;
  /** Lot 75F (§C) — candidats dont la date reste ambiguë (`TEMPORAL_AMBIGUITY`) : aucun retrait global. */
  temporalAmbiguities: number;
  /**
   * Lot 75F (§B) — rapprochements AMBIGUS (plusieurs éléments candidats) :
   * aucun n'est choisi arbitrairement ; tous sont conservés et signalés.
   */
  ambiguous: Array<{ index: number; itemIds: number[] }>;
}

const normTitre = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Cible de la clé : équipement ou pièce du candidat s'il est identifié, sinon le bien. */
export function keyTarget(target: { type: string; id: number | null } | null | undefined, assetId: number): { type: string; id: number } {
  return target && target.id != null && target.type !== 'ASSET' ? { type: target.type, id: target.id } : { type: 'ASSET', id: assetId };
}

/**
 * Élément protégé par un choix de l'utilisateur (§14.6, lot 75F §A) : jamais
 * mis à jour, déplacé, reclassé ni retiré automatiquement. Règle UNIQUE :
 *   · élément manuel (non automatique) ;
 *   · élément automatique modifié par l'utilisateur (`is_automatic_modified`) ;
 *   · statut explicitement renseigné (`manual_status` : réalisé, annulé) ;
 *   · prévision confirmée par l'utilisateur (`confirmation_mode = 'USER'`).
 * Les mêmes conditions gardent les écritures SQL (`AGENDA_UNTOUCHED_SQL`).
 */
export const isUserTouched = (i: Pick<SourceItem, 'isAutomatic' | 'isAutomaticModified' | 'manualStatus'> & { confirmationMode?: string | null }): boolean =>
  !i.isAutomatic || i.isAutomaticModified || (i.manualStatus != null && i.manualStatus !== '') || i.confirmationMode === 'USER';

/**
 * Lot 75F (§A) — garde SQL d'un élément d'agenda (alias `i`, ou nom de table)
 * qu'aucun choix utilisateur ne protège : à placer dans le WHERE de toute
 * écriture automatique, indépendamment des vérifications en mémoire.
 */
export const agendaUntouchedSql = (alias = 'agenda_items'): string =>
  `${alias}.is_automatic AND NOT COALESCE(${alias}.is_automatic_modified, false)`
  + ` AND (${alias}.manual_status IS NULL OR ${alias}.manual_status = '')`
  + ` AND ${alias}.confirmation_mode IS DISTINCT FROM 'USER'`;

/** Clé de base (sans rang `#n`). */
const cleDeBase = (k: string): string => k.replace(/#\d+$/, '');

/**
 * Plan de synchronisation des éléments automatiques d'UNE source pour UN bien.
 *
 *  1. chaque décision créatrice reçoit sa clé ; un élément rapproché de
 *     façon FIABLE est mis à jour (ou laissé s'il est protégé) au lieu d'être
 *     recréé ; un élément de la source SANS clé (antérieur à 0223) est ADOPTÉ
 *     (clé posée, mis à jour) ;
 *  2. les décisions qui visent un élément existant (doublon consolidé,
 *     confirmation, mise à jour) le conservent ;
 *  3. tout autre élément automatique intact de la source est retiré.
 *
 * Lot 75F (§B) — rapprochement FIABLE et NON AMBIGU seulement :
 *  · deux valeurs nulles (`originFieldKey`) ne prouvent jamais une identité :
 *    sans champ d'origine, la date ET l'intitulé normalisé doivent coïncider ;
 *  · clés d'une même famille (même date, `k`, `k#2`…) : le rang ne désigne
 *    pas un événement — l'intitulé départage ;
 *  · plusieurs candidats : aucun n'est choisi, tous sont conservés et
 *    l'ambiguïté est signalée (`ambiguous`) ;
 *  · une création ne reprend jamais la clé d'un élément existant non rapproché.
 * Lot 75F (§C) — une date non tranchée (`temporalAmbiguity`) conserve les
 * éléments potentiellement concernés et suspend tout retrait global.
 */
export function planSourceSync(p: {
  sourceFileId: number;
  assetId: number;
  decisions: SyncDecision[];
  items: SourceItem[];
}): SourceSyncPlan {
  const steps: SyncStep[] = [];
  const keep = new Set<number>();
  const pris = new Set<number>();
  const vus = new Map<string, number>();
  const parCle = new Map(p.items.filter((i) => i.functionalKey).map((i) => [i.functionalKey!, i]));
  const targeted = new Set<number>();
  const ambigus: Array<{ index: number; itemIds: number[] }> = [];
  let undetermined = 0;
  let temporalAmbiguities = 0;

  // Familles de clés (même clé de base) des éléments existants.
  const familles = new Map<string, SourceItem[]>();
  for (const i of p.items) {
    if (!i.functionalKey) continue;
    const b = cleDeBase(i.functionalKey);
    familles.set(b, [...(familles.get(b) ?? []), i]);
  }

  // Clé de chaque décision (créatrice, ou rejet / indécision de T4 : même calcul).
  const cles = new Map<number, { key: string; base: string; semantics: EventSemantics; occurrenceDate: boolean }>();
  const decisionsParBase = new Map<string, number>();
  for (const d of p.decisions) {
    const t4 = d.action === 'ignore' ? d.t4Outcome ?? null : null;
    if (t4 === 'abstain' || t4 === 'technical_failure') undetermined++;
    if (d.temporalAmbiguity) temporalAmbiguities++;
    if (d.existingItemId && !KEYED_ACTIONS.has(d.action)) keep.add(d.existingItemId);
    if (!KEYED_ACTIONS.has(d.action) && !t4) continue;
    if (d.sourceFileId != null && d.sourceFileId !== p.sourceFileId) continue;
    const semantics = resolveEventSemantics({ originFieldKey: d.originFieldKey, businessType: d.businessType, nature: d.nature });
    // Occurrence : celle du candidat (T4, enabled), sinon la règle par défaut.
    const occurrence = d.occurrenceIndex ?? (d.seriesKey || !d.originFieldKey ? d.date : 'single');
    const base = computeAgendaFunctionalKey({
      sourceFileId: p.sourceFileId, target: keyTarget(d.target, p.assetId),
      businessType: semantics.businessType, originFieldKey: d.originFieldKey ?? null,
      occurrence,
    });
    // Rang : seules les décisions créatrices le consomment (un rejet vise la clé produite à l'origine).
    let key = base;
    if (KEYED_ACTIONS.has(d.action)) {
      const rang = (vus.get(base) ?? 0) + 1;
      vus.set(base, rang);
      key = rang === 1 ? base : `${base}#${rang}`;
    }
    decisionsParBase.set(base, (decisionsParBase.get(base) ?? 0) + 1);
    cles.set(d.index, { key, base, semantics, occurrenceDate: occurrence !== 'single' });
  }
  const basesProduites = new Set([...cles.entries()].filter(([i]) => KEYED_ACTIONS.has(p.decisions.find((d) => d.index === i)!.action)).map(([, c]) => c.base));

  type Rapprochement = { item: SourceItem; adopted: boolean; byFamily?: boolean } | { ambiguous: SourceItem[] } | null;
  const unique = (l: SourceItem[], adopted: boolean): Rapprochement =>
    l.length === 1 ? { item: l[0], adopted } : l.length > 1 ? { ambiguous: l } : null;

  /**
   * Rapprochement d'une décision avec un élément de la source :
   *  1. même clé fonctionnelle — sans champ d'origine, l'intitulé normalisé
   *     doit aussi coïncider dès que la famille de clés est ambiguë, et
   *     toujours pour un retrait (`destructif`) ;
   *  2. élément antérieur à 0223 (sans clé) : même champ d'origine (non nul),
   *     même date si l'occurrence est une date ; sans champ d'origine, même
   *     date ET même intitulé normalisé ;
   *  3. lot 71E (§B) — élément dont la clé n'est plus produite (type métier
   *     reclassé par T4) : mêmes critères qu'en 2. Identifiant et
   *     rattachements conservés : jamais « retrait + recréation ».
   *  `conserver` (abstention, échec technique) : en cas de doute, TOUS les
   *  éléments plausibles sont rendus (ambigu) pour être conservés.
   */
  const rapprocher = (d: SyncDecision, c: { key: string; base: string; occurrenceDate: boolean }, mode: 'ecrire' | 'destructif' | 'conserver'): Rapprochement => {
    const sansChamp = !d.originFieldKey;
    const memeTitre = (i: SourceItem) => normTitre(i.title) === normTitre(d.title) && normTitre(d.title) !== '';
    if (!sansChamp) {
      const parClef = parCle.get(c.key);
      if (parClef && !pris.has(parClef.id)) return { item: parClef, adopted: false };
    } else {
      const famille = (familles.get(c.base) ?? []).filter((i) => !pris.has(i.id));
      if (famille.length) {
        const ambigue = famille.length > 1 || (decisionsParBase.get(c.base) ?? 0) > 1;
        const exacte = famille.find((i) => i.functionalKey === c.key);
        if (!ambigue && mode !== 'destructif' && exacte) return { item: exacte, adopted: false };
        const titres = famille.filter(memeTitre);
        if (titres.length === 1) return { item: titres[0], adopted: false, byFamily: titres[0].functionalKey !== c.key };
        if (titres.length > 1) return { ambiguous: titres };
        if (mode === 'conserver' && ambigue) return { ambiguous: famille };
      }
    }
    const memeChamp = (i: SourceItem) => !pris.has(i.id) && i.isAutomatic
      && (i.originFieldKey ?? null) === (d.originFieldKey ?? null)
      && (sansChamp ? i.startDate === d.date && memeTitre(i) : (!c.occurrenceDate || i.startDate === d.date));
    const anciens = unique(p.items.filter((i) => !i.functionalKey && memeChamp(i)), true);
    if (anciens) return anciens;
    return unique(p.items.filter((i) => i.functionalKey && !basesProduites.has(cleDeBase(i.functionalKey)) && memeChamp(i)), true);
  };

  // Clés déjà portées (une création ne reprend jamais la clé d'un autre élément).
  const proprietaire = new Map(p.items.filter((i) => i.functionalKey).map((i) => [i.functionalKey!, i.id]));
  const attribuees = new Set<string>();
  const cleLibre = (k: string, itemId: number | null): string => {
    const libre = (x: string) => !attribuees.has(x) && (!proprietaire.has(x) || proprietaire.get(x) === itemId);
    if (libre(k)) return k;
    const b = cleDeBase(k);
    let n = 2;
    while (!libre(`${b}#${n}`)) n++;
    return `${b}#${n}`;
  };
  const signaler = (index: number, l: SourceItem[]) => {
    for (const i of l) keep.add(i.id);
    ambigus.push({ index, itemIds: l.map((i) => i.id) });
  };

  // Date non tranchée (§C) : éléments potentiellement concernés conservés
  // (même champ d'origine, ou même intitulé normalisé, quelle que soit la date).
  for (const d of p.decisions) {
    if (!d.temporalAmbiguity) continue;
    for (const i of p.items) {
      if (d.originFieldKey ? i.originFieldKey === d.originFieldKey : normTitre(i.title) === normTitre(d.title)) keep.add(i.id);
    }
  }

  for (const d of p.decisions) {
    const c = cles.get(d.index);
    if (!c || !KEYED_ACTIONS.has(d.action)) continue;
    const r = rapprocher(d, c, 'ecrire');
    if (!r) {
      const key = cleLibre(c.key, null);
      attribuees.add(key);
      steps.push({ kind: 'create', index: d.index, key, semantics: c.semantics });
      continue;
    }
    if ('ambiguous' in r) {
      signaler(d.index, r.ambiguous);
      steps.push({ kind: 'ambiguous', index: d.index, key: c.key, itemIds: r.ambiguous.map((i) => i.id) });
      continue;
    }
    pris.add(r.item.id);
    keep.add(r.item.id);
    // Rapproché dans sa famille (rang différent) : l'élément GARDE sa clé.
    const key = r.byFamily && r.item.functionalKey ? r.item.functionalKey : cleLibre(c.key, r.item.id);
    attribuees.add(key);
    if (isUserTouched(r.item)) steps.push({ kind: 'protected', index: d.index, key, itemId: r.item.id });
    else steps.push({ kind: 'update', index: d.index, key, itemId: r.item.id, semantics: c.semantics, adopted: r.adopted });
  }
  // Indécision (abstention, échec technique) : l'élément rapproché — ou tous les éléments plausibles — conservés.
  for (const d of p.decisions) {
    const c = cles.get(d.index);
    if (!c || d.action !== 'ignore' || d.t4Outcome === 'reject') continue;
    const r = rapprocher(d, c, 'conserver');
    if (!r) continue;
    if ('ambiguous' in r) { for (const i of r.ambiguous) keep.add(i.id); continue; }
    pris.add(r.item.id);
    keep.add(r.item.id);
  }
  // Rejet explicite : retrait CIBLÉ de l'élément rapproché de façon fiable et
  // non ambiguë, s'il est automatique et intact ; ambiguïté → rien, signalée.
  for (const d of p.decisions) {
    const c = cles.get(d.index);
    if (!c || d.action !== 'ignore' || d.t4Outcome !== 'reject') continue;
    const r = rapprocher(d, c, 'destructif');
    if (!r) continue;
    if ('ambiguous' in r) { signaler(d.index, r.ambiguous); continue; }
    if (!keep.has(r.item.id) && !isUserTouched(r.item)) { pris.add(r.item.id); targeted.add(r.item.id); }
  }

  const remove = p.items.filter((i) => !keep.has(i.id) && !isUserTouched(i)).map((i) => i.id);
  for (const i of p.items) if (isUserTouched(i)) keep.add(i.id);
  return {
    sourceFileId: p.sourceFileId, steps, remove, keep: [...keep], targetedRemove: [...targeted], undetermined,
    temporalAmbiguities, ambiguous: ambigus,
  };
}
