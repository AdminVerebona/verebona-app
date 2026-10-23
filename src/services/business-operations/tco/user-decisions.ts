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
 *   o:<Opération>:<nature>:<montant>:<devise> — composante SANS justificatif
 *     (fiche, saisie, sinistre) : l'Opération est l'identité la plus stable ;
 *   asset:<bien>:acquisitionPrice / equipment:<équipement>:acquisitionPrice —
 *     prix d'achat de la fiche (identifiants stables).
 * Le montant fait partie de la clé : un montant corrigé est un autre fait (la
 * décision ne s'y applique plus ; elle reste journalisée et visible au BO).
 *
 * APPLICATION (priorité sur les règles automatiques, pour CETTE ligne)
 *   · décision appliquée aux lignes dont c'est la clé PRINCIPALE, sinon (aucune)
 *     à celles dont c'est une clé secondaire (transition justificatif → T3) ;
 *   · plusieurs décisions sur une même ligne : la plus récente l'emporte ;
 *   · RETIRER : toute ligne retenue visée sort du total (motif USER_EXCLUDED) ;
 *   · AJOUTER : si le fait est déjà retenu par une ligne visée, rien ne change ;
 *     sinon UNE SEULE ligne visée est comptée (jamais deux fois le même fait
 *     par une même décision), à son montant en euros ; une prévision ajoutée
 *     est comptée comme une dépense réalisée ;
 *   · jamais ajoutable : montant inconnu, devise sans contre-valeur, autre
 *     bien, ligne déjà portée par une autre dépense, document qui n'est pas
 *     une dépense (règlement, capital, prix de vente) ;
 *   · doublon présumé (`tcoAddDuplicateRisk`) : la confirmation l'annonce
 *     explicitement (refus serveur sans confirmation), la ligne ajoutée reste
 *     signalée (USER_INCLUDED_DUPLICATES) — jamais un double comptage à
 *     l'insu de l'utilisateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { COMPONENT_EFFECT, EXCLUSION_LABELS, ledgerKey, type LedgerEntry } from '../finance/engine';
import { DOCUMENT_LINE_REASON_LABELS, type EconomicLineReason, type EconomicLineStatus } from '../finance/economic-lines';
import type { TcoCategory, TcoEconomicLine, TcoWarning } from './model';

export type TcoUserDecisionValue = 'INCLUDE' | 'EXCLUDE';

/** Décision persistée (table `asset_cost_line_decisions`, migration 0623). */
export interface TcoUserDecision {
  key: string;
  decision: TcoUserDecisionValue;
  decidedAt: string;
  decidedByUserId: number | null;
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
}

const RETENUE = (s: EconomicLineStatus) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';

type KeyLine = Pick<TcoEconomicLine, 'id' | 'source' | 'kind' | 'amountMinor' | 'currency' | 'fileId' | 'sourceFileIds' | 'operationId'>;

/** Clés stables d'une ligne : principale et secondaires (pure). */
export function tcoLineKeys(l: KeyLine): { primary: string; secondary: string[] } {
  if (l.source === 'ASSET_DATA' || l.source === 'EQUIPMENT_DATA') return { primary: l.id, secondary: [] };
  const fait = `${l.kind ?? 'NONE'}:${l.amountMinor}:${String(l.currency ?? '').trim().toUpperCase()}`;
  let fichiers: number[];
  if (l.source === 'OPERATION') {
    // Provenance lue : SES justificatifs seulement (jamais le justificatif principal d'une autre transaction).
    fichiers = l.sourceFileIds ? [...new Set(l.sourceFileIds)] : l.fileId != null ? [l.fileId] : [];
    if (!fichiers.length) return { primary: `o:${l.operationId ?? 0}:${fait}`, secondary: [] };
  } else fichiers = l.fileId != null ? [l.fileId] : [];
  if (!fichiers.length) return { primary: l.id, secondary: [] };
  const principal = l.fileId != null && fichiers.includes(l.fileId) ? l.fileId : [...fichiers].sort((a, b) => a - b)[0];
  return {
    primary: `f:${principal}:${fait}`,
    secondary: fichiers.filter((f) => f !== principal).sort((a, b) => a - b).map((f) => `f:${f}:${fait}`),
  };
}

/** Une ligne retenue peut-elle être retirée ? (le prix de cession n'est pas une dépense). */
export function tcoLineRemovable(l: Pick<TcoEconomicLine, 'status' | 'kind'>): boolean {
  return RETENUE(l.status) && l.kind !== 'PROCEED';
}

/** Une ligne non retenue peut-elle être ajoutée ? Motif en langage utilisateur sinon (pure). */
export function tcoLineAddable(l: Pick<TcoEconomicLine, 'status' | 'kind' | 'eurCents' | 'amountUnknown'>): { ok: true } | { ok: false; reason: string } {
  if (RETENUE(l.status)) return { ok: false, reason: 'Déjà retenue dans le coût de possession.' };
  if (l.amountUnknown) return { ok: false, reason: 'Montant inconnu : renseignez le montant du document pour pouvoir l’ajouter.' };
  if (l.status === 'OUT_OF_SCOPE') return { ok: false, reason: 'Dépense attribuée à un autre bien.' };
  if (l.status === 'CONSOLIDATED_ELSEWHERE') return { ok: false, reason: 'Déjà comptée par une autre dépense : utilisez la dépense qui la porte.' };
  if (l.status === 'UNCONVERTED' || l.eurCents == null) return { ok: false, reason: 'Montant en devise étrangère sans contre-valeur en euros : il ne peut pas être ajouté.' };
  if (!l.kind || l.kind === 'PROCEED') return { ok: false, reason: 'Ce document n’est pas une dépense (règlement, capital emprunté ou prix de vente).' };
  return { ok: true };
}

/** Motifs pour lesquels le moteur considère la ligne comme DÉJÀ comptée ailleurs. */
const DEJA_COMPTEE: ReadonlySet<string> = new Set([
  'SAME_FACT_OTHER_DOCUMENT', 'SAME_AS_ASSET_PRICE', 'SAME_AS_EQUIPMENT_DOCUMENT', 'DUPLICATE_COPY', 'DUPLICATE_REFERENCE',
  'COVERED_BY_OPERATION', 'SOURCE_WITHDRAWN', 'INCLUDED_IN_OPERATION_TOTAL', 'INCLUDED_IN_TOTAL_SAME_DOCUMENT', 'INCLUDED_IN_TOTAL_INVOICE',
  'ASSET_PRICE_CONSOLIDATED', 'EQUIPMENT_PRICE_CONSOLIDATED',
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

type Entry = LedgerEntry & { category: TcoCategory | null };

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
  for (const l of x.lines) {
    const k = tcoLineKeys(l);
    l.decisionKey = k.primary;
    parPrincipale.set(k.primary, [...(parPrincipale.get(k.primary) ?? []), l]);
    for (const s of k.secondary) parSecondaire.set(s, [...(parSecondaire.get(s) ?? []), l]);
  }
  const orphans: TcoUserDecision[] = [];
  if (!x.decisions.length) return { applied: 0, includedDuplicates: 0, orphans };
  const entree = new Map<string, Entry>();
  for (const e of x.entries) if (!entree.has(ledgerKey(e))) entree.set(ledgerKey(e), e);
  let applied = 0;
  let includedDuplicates = 0;
  // La plus récente d'abord : une ligne déjà décidée n'est plus touchée (la plus récente l'emporte).
  const ordre = [...x.decisions].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || a.key.localeCompare(b.key));
  const trace = (l: TcoEconomicLine, d: TcoUserDecision, ok: boolean): void => {
    l.userDecision = { key: d.key, decision: d.decision, decidedAt: d.decidedAt, decidedByUserId: d.decidedByUserId, applied: ok, automaticStatus: l.status, automaticReason: l.reason };
  };
  for (const d of ordre) {
    let cibles = (parPrincipale.get(d.key) ?? []).filter((l) => !l.userDecision);
    if (!cibles.length && !parPrincipale.has(d.key)) cibles = (parSecondaire.get(d.key) ?? []).filter((l) => !l.userDecision);
    if (!cibles.length) { if (!parPrincipale.has(d.key) && !parSecondaire.has(d.key)) orphans.push(d); continue; }
    if (d.decision === 'EXCLUDE') {
      for (const l of cibles) {
        const ok = tcoLineRemovable(l);
        trace(l, d, ok);
        if (!ok) continue;
        const e = entree.get(l.id);
        if (e) { e.included = false; e.includedEurMinor = 0; e.category = null; e.prorata = null; }
        l.status = 'EXCLUDED'; l.reason = 'USER_EXCLUDED'; l.includedCents = 0;
        delete l.uncertain;
        l.note = 'Retirée du coût de possession par vous.';
        applied += 1;
      }
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
    const kind = l.kind === 'FORECAST_COST' ? 'REALIZED_COST' : l.kind!;
    const effect = COMPONENT_EFFECT[kind];
    const opCat = l.operationId != null ? x.operationCategory.get(l.operationId) : undefined;
    // Catégorie effacée par la règle automatique (doublon, autre achat) : celle de l'Opération ; un achat ajouté
    // n'est jamais « l'acquisition du bien » (déjà établie ou non) — accessoire / achat complémentaire.
    const repli: TcoCategory = l.source !== 'OPERATION' || !opCat ? 'OTHER' : opCat === 'ACQUISITION' ? 'ACCESSORIES' : opCat;
    const category: TcoCategory | null = effect === 'COST' ? (l.category ?? repli) : null;
    const eur = l.eurCents!;
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
    l.reason = null; l.includedCents = eur; l.kind = kind; l.category = category;
    delete l.uncertain; delete l.duplicateOf;
    l.note = `Ajoutée au coût de possession par vous.${risque ? ` ${risque}` : ''}`;
    if (risque) { includedDuplicates += 1; x.warnings.add('USER_INCLUDED_DUPLICATES'); }
    applied += 1;
  }
  if (applied) {
    x.warnings.add('USER_DECISIONS');
    // Signalements automatiques (78B) qui ne portent plus sur aucune ligne après décision : retirés.
    if (!x.lines.some((l) => l.status === 'DUPLICATE' && l.reason === 'SAME_FACT_OTHER_DOCUMENT')) x.warnings.delete('PRESUMED_DUPLICATES');
    if (!x.lines.some((l) => l.reason === 'NOT_OWNERSHIP_COST')) x.warnings.delete('NOT_OWNERSHIP_COSTS');
  }
  return { applied, includedDuplicates, orphans };
}
