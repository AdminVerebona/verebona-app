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

export interface FunctionalKeyInput {
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

export interface EventSemantics {
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
}

/** Actions qui CRÉENT un élément et portent donc une clé. */
export const KEYED_ACTIONS = new Set(['create', 'propose', 'create_conflict']);

export type SyncStep =
  | { kind: 'create'; index: number; key: string; semantics: EventSemantics }
  | { kind: 'update'; index: number; key: string; itemId: number; semantics: EventSemantics; adopted: boolean }
  | { kind: 'protected'; index: number; key: string; itemId: number };

export interface SourceSyncPlan {
  sourceFileId: number;
  steps: SyncStep[];
  /** Éléments automatiques de la source que plus rien ne produit : retirés. */
  remove: number[];
  /** Éléments conservés (produits, confirmés, ou modifiés à la main). */
  keep: number[];
}

/** Cible de la clé : équipement ou pièce du candidat s'il est identifié, sinon le bien. */
export function keyTarget(target: { type: string; id: number | null } | null | undefined, assetId: number): { type: string; id: number } {
  return target && target.id != null && target.type !== 'ASSET' ? { type: target.type, id: target.id } : { type: 'ASSET', id: assetId };
}

/** Élément touché par l'utilisateur (§14.6) : jamais mis à jour ni retiré. */
export const isUserTouched = (i: Pick<SourceItem, 'isAutomatic' | 'isAutomaticModified' | 'manualStatus'>): boolean =>
  !i.isAutomatic || i.isAutomaticModified || (i.manualStatus !== null && i.manualStatus !== '');

/**
 * Plan de synchronisation des éléments automatiques d'UNE source pour UN bien.
 *
 *  1. chaque décision créatrice reçoit sa clé ; un élément de même clé est
 *     mis à jour (ou laissé s'il a été modifié à la main) au lieu d'être
 *     recréé ; un élément de la source SANS clé (antérieur à 0223), de même
 *     champ d'origine — et de même date si l'occurrence est une date — est
 *     ADOPTÉ (clé posée, mis à jour) ;
 *  2. les décisions qui visent un élément existant (doublon consolidé,
 *     confirmation, mise à jour) le conservent ;
 *  3. tout autre élément automatique intact de la source est retiré.
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

  for (const d of p.decisions) {
    if (d.existingItemId && !KEYED_ACTIONS.has(d.action)) keep.add(d.existingItemId);
    if (!KEYED_ACTIONS.has(d.action)) continue;
    if (d.sourceFileId != null && d.sourceFileId !== p.sourceFileId) continue;
    const semantics = resolveEventSemantics({ originFieldKey: d.originFieldKey, businessType: d.businessType, nature: d.nature });
    // Occurrence : celle du candidat (T4, enabled), sinon la règle par défaut.
    const occurrence = d.occurrenceIndex ?? (d.seriesKey || !d.originFieldKey ? d.date : 'single');
    const occurrenceDate = occurrence !== 'single';
    const base = computeAgendaFunctionalKey({
      sourceFileId: p.sourceFileId, target: keyTarget(d.target, p.assetId),
      businessType: semantics.businessType, originFieldKey: d.originFieldKey ?? null,
      occurrence,
    });
    const rang = (vus.get(base) ?? 0) + 1;
    vus.set(base, rang);
    const key = rang === 1 ? base : `${base}#${rang}`;

    let item = parCle.get(key);
    let adopted = false;
    if (!item) {
      item = p.items.find((i) => !i.functionalKey && !pris.has(i.id) && i.isAutomatic
        && (i.originFieldKey ?? null) === (d.originFieldKey ?? null)
        && (!occurrenceDate || i.startDate === d.date));
      adopted = !!item;
    }
    if (!item) { steps.push({ kind: 'create', index: d.index, key, semantics }); continue; }
    pris.add(item.id);
    keep.add(item.id);
    if (isUserTouched(item)) steps.push({ kind: 'protected', index: d.index, key, itemId: item.id });
    else steps.push({ kind: 'update', index: d.index, key, itemId: item.id, semantics, adopted });
  }

  const remove = p.items.filter((i) => !keep.has(i.id) && !isUserTouched(i)).map((i) => i.id);
  for (const i of p.items) if (isUserTouched(i)) keep.add(i.id);
  return { sourceFileId: p.sourceFileId, steps, remove, keep: [...keep] };
}
