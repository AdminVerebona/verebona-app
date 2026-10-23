/**
 * Lot 84E — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-6
 * (§9.1, §9.2, §24, §25 ; AC45, AC46 ; E22, E27) : IDENTITÉ DE SÉRIE d'une
 * relation récurrente (factures successives d'un même service), lue de façon
 * DÉTERMINISTE dans le contrat T1 ACTUEL. Règles PURES (aucune base, aucune
 * IA) — extension des signaux 55B, pas un second moteur : la décision reste
 * celle de `decideCandidate` (M0 / M1 / M2 / M3), cette règle n'y ajoute
 * qu'un rapprochement CERTAIN (M1, motif `SERIES …`) quand l'identité du
 * service est établie, et une EXCLUSION quand deux services sont prouvés
 * distincts.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE CONTRAT T1 ACTUEL TRANSPORTE (O-5, lecture déterministe)
 *
 *   prestataire               `provider` (normalisé : `normalizeProvider`)
 *   référence de contrat      `businessReferences` CONTRACT / POLICY
 *   compte / n° client        `businessReferences` CUSTOMER
 *   période facturée          `financialHints[].periodStart / periodEnd`,
 *                             portée `INSTALLMENT` (`hasRecurringPeriod`)
 *   équipement                `targetHints` EQUIPMENT certain avec identifiant
 *                             vérifié (`equipmentIds`) ; désignation brute
 *                             (`rawLabel`) quand l'équipement n'existait pas
 *                             encore — utilisée pour les liens directs
 *                             (`direct-links.ts`), jamais comme clé de série
 *   nature de service         ABSENTE du contrat (aucun champ structuré) :
 *                             demande IA `84E-t1-identifiants-recurrence`.
 *                             En attendant, l'intitulé ne sert qu'à BLOQUER
 *                             (natures connues et différentes → l'IA M3
 *                             tranche), jamais à prouver.
 *
 * NIVEAUX (CDC §9 : certain → automatique, probable → « À traiter »,
 * insuffisant → rien ; seuils dans le CODE) :
 *
 *   DISTINCT     deux services PROUVÉS différents : références de contrat
 *                (ou de police) divergentes, équipements explicites
 *                disjoints. Aucun rapprochement, aucun appel IA (deux
 *                contrats du même prestataire ne sont jamais regroupés).
 *                Deux numéros de CLIENT différents ne prouvent rien
 *                (changement de compte) : NONE, le faisceau décide.
 *   ESTABLISHED  même prestataire (connu des deux côtés) ET une CLÉ DE
 *                SERVICE commune (référence de contrat / police, compte
 *                client, ou équipement certain) ET une échéance des deux
 *                côtés (période facturée / INSTALLMENT, ou contrat) ET
 *                biens compatibles ET aucune période déjà facturée par la
 *                série (un service n'est pas facturé deux fois pour la même
 *                période : deux services parallèles d'un même compte client
 *                restent à l'IA) ET natures non contradictoires.
 *                → rapprochement CERTAIN, sous le contrôle d'identité
 *                économique 78A (base `SERIES`).
 *   NONE         la règle ne conclut pas : le faisceau existant (55B, lot 53)
 *                décide — plausible → M3 → carte ; sinon rien.
 *
 * Un simple prestataire commun ne suffit JAMAIS (§9.1, D6). Une différence
 * de période, de date ou de montant ne crée pas, à elle seule, une autre
 * Opération (AC46) — mais un montant d'un autre ordre de grandeur est une
 * contradiction 78A (base `SERIES`, `economic-identity.ts`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationTypeCode, ReferenceKind } from '../model';
import { billingPeriodKey, hasRecurringPeriod, type CandidateIdentity } from './model';

/** Opération telle que la règle de série la lit (sous-ensemble de `ExistingOperation`). */
export interface SeriesOperationView {
  id: number;
  typeCode: BusinessOperationTypeCode | null;
  providerKey: string | null;
  assetIds: readonly number[];
  refs: ReadonlyArray<{ kind: ReferenceKind; normalized: string }>;
  /** Échéances (CONTRACT, ou coûts actifs à période facturée réelle). */
  periodic?: boolean;
  /** Lot 84E : périodes facturées des coûts actifs (`début/fin`). */
  periods?: readonly string[];
  /** Lot 84E : équipements liés à l'Opération. */
  equipmentIds?: readonly number[];
  /** Libellé technique (nature des travaux), pour le seul blocage « natures différentes ». */
  label?: string | null;
  invalidated?: boolean;
  agendaOnly?: boolean;
}

export type SeriesLevel = 'ESTABLISHED' | 'DISTINCT' | 'NONE';

export interface SeriesAssessment {
  level: SeriesLevel;
  /** Clés de service communes (`CONTRACT:X`, `CUSTOMER:Y`, `EQUIPMENT:12`). */
  keys: string[];
  /** Motifs (codes stables) d'une distinction ou d'un renvoi au faisceau. */
  reasons: string[];
}

/** Natures de types compatibles avec une relation récurrente (55B : contrat ou échéance mal qualifiée). */
const TYPES_SERIE = new Set<BusinessOperationTypeCode | null>(['CONTRACT', 'INTERVENTION', 'OTHER', null]);

/** Familles de références qui IDENTIFIENT un service récurrent (jamais une facture). */
export const SERIES_REFERENCE_FAMILIES: ReadonlyArray<readonly ReferenceKind[]> = [['CONTRACT', 'POLICY'], ['CUSTOMER']];

const refSet = (refs: ReadonlyArray<{ kind: ReferenceKind; normalized: string }>, kinds: readonly ReferenceKind[]) =>
  new Set(refs.filter((r) => kinds.includes(r.kind)).map((r) => r.normalized));

const MOTS_NEUTRES = new Set([
  'facture', 'factures', 'avoir', 'echeance', 'echeances', 'mensuel', 'mensuelle', 'mensualite', 'trimestre', 'trimestriel',
  'trimestrielle', 'annuel', 'annuelle', 'abonnement', 'contrat', 'service', 'services', 'prestation', 'prestations', 'periode',
  'client', 'numero', 'reference', 'montant', 'total', 'pour', 'avec', 'dans', 'votre', 'notre', 'janvier', 'fevrier', 'mars',
  'avril', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
]);

/** Mots porteurs de nature d'un intitulé (≥ 4 lettres, hors mots de facturation récurrente et de calendrier). Pure. */
export function serviceNatureTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const mots = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/);
  return new Set(mots.filter((m) => m.length >= 4 && !/^\d+$/.test(m) && !MOTS_NEUTRES.has(m)));
}

/** Périodes facturées d'un candidat (`début/fin`), dédoublonnées. Pure. */
export function candidatePeriods(c: Pick<CandidateIdentity, 'hints'>): string[] {
  const out = new Set<string>();
  for (const h of c.hints) {
    if (typeof h.periodStart === 'string' && typeof h.periodEnd === 'string' && h.periodStart < h.periodEnd) out.add(`${h.periodStart}/${h.periodEnd}`);
  }
  return [...out].sort();
}

/** Deux périodes `début/fin` se chevauchent-elles (bornes incluses) ? Pure. */
export function periodsOverlap(a: string, b: string): boolean {
  const [a0, a1] = a.split('/');
  const [b0, b1] = b.split('/');
  return !!a0 && !!a1 && !!b0 && !!b1 && a0 <= b1 && b0 <= a1;
}

/** Le candidat porte-t-il une relation récurrente (échéance, ou document de contrat) ? Pure. */
export const isRecurringCandidate = (c: Pick<CandidateIdentity, 'hints' | 'type'>): boolean => c.type === 'CONTRACT' || hasRecurringPeriod(c);

/**
 * Identité de série d'un candidat face à une Opération (pure, symétrique sur
 * les références). Voir l'en-tête : DISTINCT / ESTABLISHED / NONE.
 */
export function assessSeries(c: CandidateIdentity, op: SeriesOperationView): SeriesAssessment {
  const none = (reasons: string[] = []): SeriesAssessment => ({ level: 'NONE', keys: [], reasons });
  // Sources agenda / données structurées : leur rapprochement est ailleurs.
  if (c.agenda || c.structured || op.agendaOnly || op.invalidated) return none();
  if (!TYPES_SERIE.has(c.type) || !TYPES_SERIE.has(op.typeCode)) return none();
  const recurrent = isRecurringCandidate(c);
  const serie = op.periodic === true || op.typeCode === 'CONTRACT';
  if (!recurrent || !serie) return none();

  // 1. Services PROUVÉS distincts (références identifiantes divergentes, équipements disjoints).
  const distinct: string[] = [];
  const divergent = (kinds: readonly ReferenceKind[]) => {
    const a = refSet(c.refs, kinds);
    const b = refSet(op.refs, kinds);
    return a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));
  };
  // Deux numéros de contrat (ou de police) différents : deux contrats (règle 55B des couples croisés, généralisée).
  if (divergent(['CONTRACT', 'POLICY'])) distinct.push('REFERENCE_DIFFERENT_CONTRACT_POLICY');
  // Deux numéros de client différents : PAS une preuve (changement de compte chez le même prestataire) — le faisceau décide.
  const clientDivergent = divergent(['CUSTOMER']);
  const eqOp = op.equipmentIds ?? [];
  if (c.equipmentIds.length && eqOp.length && !c.equipmentIds.some((e) => eqOp.includes(e))) distinct.push('EQUIPMENT_DISJOINT');
  if (c.providerKey !== null && op.providerKey !== null && c.providerKey !== op.providerKey) {
    // Deux prestataires : jamais la même série (la référence d'un tiers n'identifie rien chez un autre).
    return distinct.length ? { level: 'DISTINCT', keys: [], reasons: distinct } : none(['PROVIDER_DIFFERENT']);
  }
  if (distinct.length) return { level: 'DISTINCT', keys: [], reasons: distinct };

  // 2. Identité ÉTABLIE : prestataire connu des deux côtés + une clé de service commune.
  if (c.providerKey === null || op.providerKey === null) return none(['PROVIDER_UNKNOWN']);
  if (clientDivergent) return none(['CUSTOMER_DIFFERENT']);
  if (c.assetIds.length && op.assetIds.length && !c.assetIds.some((a) => op.assetIds.includes(a))) return none(['TARGET_INCOMPATIBLE']);
  const keys: string[] = [];
  for (const fam of SERIES_REFERENCE_FAMILIES) {
    const b = refSet(op.refs, fam);
    for (const r of c.refs) if (fam.includes(r.kind) && b.has(r.normalized)) keys.push(`${fam[0]}:${r.normalized}`);
  }
  for (const e of c.equipmentIds) if (eqOp.includes(e)) keys.push(`EQUIPMENT:${e}`);
  const cles = [...new Set(keys)].sort();
  if (!cles.length) return none(['NO_SERVICE_KEY']);
  // Un service n'est pas facturé deux fois pour la même période : deux services parallèles d'un même client.
  const deja = op.periods ?? [];
  const chevauche = candidatePeriods(c).some((p) => deja.some((q) => periodsOverlap(p, q)));
  if (chevauche) return { level: 'NONE', keys: cles, reasons: ['PERIOD_ALREADY_BILLED'] };
  // Nature : seulement un BLOCAGE (natures connues et différentes) — jamais une preuve (contrat T1 sans nature).
  const na = serviceNatureTokens(c.summary);
  const nb = serviceNatureTokens(op.label ?? null);
  if (na.size && nb.size && ![...na].some((m) => nb.has(m))) return { level: 'NONE', keys: cles, reasons: ['SERVICE_NATURE_DIFFERENT'] };
  return { level: 'ESTABLISHED', keys: cles, reasons: [] };
}

/** Trace stable d'une série établie (`t3_detail.certain[].why`). */
export const seriesWhy = (a: SeriesAssessment): string => `SERIES ${a.keys.join(',')}`;
export const isSeriesWhy = (why: string | null | undefined): boolean => typeof why === 'string' && why.startsWith('SERIES ');

/** Clé de période (réexport 55B, pour les lecteurs de ce module). */
export { billingPeriodKey };
