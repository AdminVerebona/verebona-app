/**
 * Sources ASSET_DATA : données STRUCTURÉES du bien qui établissent une
 * Opération — règles PURES (lot 43, O4 ; CDC Opérations V1 ch. 14, 26, B1,
 * B13.1, B13.3, B13.6, B18, C2, C5, C7.1, C7.3, C7.6, C11.1, C13, C18,
 * C23.1 ; décisions PO Q5, Q6, Q12 du 11/10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS RÉALITÉS, LUES SUR LA FICHE (le bien reste la source de vérité, B1)
 *
 *   ACQUISITION  date et/ou prix d'achat (`acquisitionDate`, `acquisitionPrice`)
 *                — rien pour un véhicule en LLD / LOA / prêt (C13 : contrat,
 *                pas entrée en possession) ;
 *   DISPOSAL     statut VENDU ou TRANSMIS (B13.6 : « statut VENDU + date de
 *                vente constitue une source structurée suffisante ») ; date =
 *                date de vente saisie (`saleDate`), à défaut date du passage
 *                au statut (`assets.status_changed_at`, repli C7.6 / C11.1) ;
 *                prix réalisé (`salePrice`) → PROCEED, VENDU seulement
 *                (Q5 : TRANSMIS = cession SANS prix) ;
 *   CONTRACT     assureur ET n° de contrat d'assurance (Q6 : seulement si les
 *                DEUX sont renseignés) — référence POLICY.
 *
 * GARDE ANTI-BLANCHIMENT (C2 « USER si saisie / corrigée explicitement ») :
 * seule une valeur d'origine humaine (USER, ADMIN — `isHumanOrigin`) compte.
 * Une valeur écrite automatiquement (T1, T3, règle système, import) ne crée,
 * ne date ni ne chiffre rien : sinon un montant documentaire recopié sur la
 * fiche reviendrait comme « donnée structurée » et doublerait sa propre
 * Opération. Une valeur historique sans origine tracée est lue USER (règle
 * commune de `readOrigin`, CDC 15 §14.3 : protégée comme une saisie).
 *
 * Le prix SOUHAITÉ (informations commerciales) et la valeur ESTIMÉE ne sont
 * jamais lus ici (C18, P17, Q12 : aucune Opération depuis une valeur).
 *
 * AUTORITÉ (9.3, B9) : une donnée saisie sur la fiche est la correction
 * explicite de l'utilisateur pour le fait qu'elle porte — date de
 * l'acquisition / de la cession, prix d'achat, prix de vente réalisé. Elle
 * prime sur la preuve documentaire pour CE fait (`applyStructuredAuthority`) :
 * jamais deux montants additionnés pour le même achat ou la même vente
 * (C7.1, C7.6, C12.1).
 *
 * Aucune propagation inverse : rien ici n'écrit la fiche (pas de boucle
 * fiche ↔ Opération).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { isHumanOrigin } from '@/services/ai/reconciliation/field-origin';
import { readCanonicalValue, type AssetRowJson } from '@/services/canonical/asset-state/canonical-asset-view';
import { eurToCents } from '@/services/canonical/registry/normalize';
import { isIsoDate, normalizeBusinessReference, type BusinessOperationTypeCode, type FinancialComponentKind } from '../model';
import { normalizeProvider, type CandidateIdentity, type ConsolidatedState, type SourceContribution } from './model';

export const ASSET_DATA_NATURES = ['ACQUISITION', 'DISPOSAL', 'CONTRACT'] as const;
export type AssetDataNature = (typeof ASSET_DATA_NATURES)[number];

/**
 * Version de la migration structurée (C23.1 : « clé stable dérivée du compte,
 * du bien, du champ et de la version de migration »). Changer cette valeur
 * fait repasser TOUS les biens une fois (règles modifiées).
 */
export const ASSET_DATA_MIGRATION_VERSION = 'o4-c23.1-v1';

/**
 * Clés canoniques de la fiche dont la modification réévalue les Opérations
 * structurées (TRG-008 à TRG-010, via `asset_updated`). Le statut (colonne)
 * s'y ajoute.
 */
export const OPERATION_ASSET_DATA_KEYS: ReadonlySet<string> = new Set([
  'acquisitionDate', 'acquisitionPrice', 'vehicleOwnershipStatus', 'saleDate', 'salePrice', 'insurer', 'insuranceContractNumber',
]);

const NON_OWNERSHIP_VEHICLE = new Set(['LLD', 'LOA', 'PRET_GRATUIT']);

/** Ligne `assets` lue pour les Opérations (row_to_json : `status_changed_at` présent après 0322). */
export type AssetDataRow = AssetRowJson & { status?: string | null; status_changed_at?: string | null; deleted_at?: string | null };

export interface AssetDataFact {
  nature: AssetDataNature;
  /** Date de l'acquisition / de la cession (AAAA-MM-JJ), null si inconnue. */
  date: string | null;
  /** D'où vient la date : champ saisi, ou date du passage au statut (repli C7.6). */
  dateBasis: 'FIELD' | 'STATUS_CHANGE' | null;
  /** Montant en centimes (prix d'achat, prix de vente réalisé), EUR. */
  amountMinor: number | null;
  /** Organisme (assureur) — CONTRACT. */
  provider: string | null;
  /** N° de contrat d'assurance — CONTRACT. */
  reference: string | null;
  /** Cession : vente (VENDU) ou transmission (TRANSMIS). */
  disposalKind?: 'SALE' | 'TRANSMISSION';
}

export type AssetDataFacts = Record<AssetDataNature, AssetDataFact | null>;

/** Jour de Paris d'un horodatage (la date de passage au statut est un instant). */
export function parisDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Valeur humaine normalisée d'une clé canonique (null : absente ou automatique). */
function humanValue(row: AssetDataRow, key: string): unknown {
  const st = readCanonicalValue(row, key);
  if (!st || st.normalized === false || !isHumanOrigin(st.origin)) return null;
  return st.value;
}

const texte = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const jour = (v: unknown): string | null => (typeof v === 'string' && isIsoDate(v.slice(0, 10)) ? v.slice(0, 10) : null);
function centimes(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  try { return eurToCents(v); } catch { return null; }
}

/** Réalités établies par les données structurées du bien (pure). */
export function assetDataFacts(row: AssetDataRow): AssetDataFacts {
  const out: AssetDataFacts = { ACQUISITION: null, DISPOSAL: null, CONTRACT: null };
  if (row.deleted_at) return out;

  const proprietaire = !(row.category === 'VEHICULE' && NON_OWNERSHIP_VEHICLE.has(String(readCanonicalValue(row, 'vehicleOwnershipStatus')?.value ?? '')));
  if (proprietaire) {
    const date = jour(humanValue(row, 'acquisitionDate'));
    const prix = centimes(humanValue(row, 'acquisitionPrice'));
    if (date !== null || prix !== null) {
      out.ACQUISITION = { nature: 'ACQUISITION', date, dateBasis: date ? 'FIELD' : null, amountMinor: prix, provider: null, reference: null };
    }
  }

  const statut = String(row.status ?? '').toUpperCase();
  if (statut === 'VENDU' || statut === 'TRANSMIS') {
    const saisie = jour(humanValue(row, 'saleDate'));
    const repli = parisDay(row.status_changed_at ?? null);
    out.DISPOSAL = {
      nature: 'DISPOSAL',
      date: saisie ?? repli,
      dateBasis: saisie ? 'FIELD' : repli ? 'STATUS_CHANGE' : null,
      // Q5 : une transmission est une cession sans prix.
      amountMinor: statut === 'VENDU' ? centimes(humanValue(row, 'salePrice')) : null,
      provider: null,
      reference: null,
      disposalKind: statut === 'VENDU' ? 'SALE' : 'TRANSMISSION',
    };
  }

  const assureur = texte(humanValue(row, 'insurer'));
  const numero = texte(humanValue(row, 'insuranceContractNumber'));
  // Q6 : seulement si l'assureur ET le numéro sont renseignés (et saisis).
  if (assureur && numero && normalizeBusinessReference(numero)) {
    out.CONTRACT = { nature: 'CONTRACT', date: null, dateBasis: null, amountMinor: null, provider: assureur, reference: numero };
  }
  return out;
}

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** Version d'une contribution (source_version) : change à chaque modification pertinente (C2). */
export function assetDataFactVersion(fact: AssetDataFact): string {
  return `ad1:${hash(fact)}`;
}

/** Empreinte des données structurées examinées pour un bien (repère de migration). */
export function assetDataFingerprint(facts: AssetDataFacts, status: string | null | undefined): string {
  return hash({ v: ASSET_DATA_MIGRATION_VERSION, status: status ?? null, facts });
}

const LIBELLES: Record<AssetDataNature, string> = {
  ACQUISITION: 'Acquisition saisie sur la fiche du bien',
  DISPOSAL: 'Cession saisie sur la fiche du bien',
  CONTRACT: 'Contrat d\'assurance saisi sur la fiche du bien',
};

/**
 * Identité candidate d'une donnée structurée (même forme qu'un candidat T1 :
 * même machine C5 / C6 / C7, mêmes règles d'état consolidé).
 *   · `forMatching` : le numéro d'assurance est aussi présenté comme
 *     référence CONTRACT — un contrat documentaire peut l'avoir extrait sous
 *     l'une ou l'autre nature (même famille identifiante C7.3) ; la
 *     contribution consolidée, elle, n'ajoute qu'une référence POLICY.
 */
export function assetDataIdentity(assetId: number, fact: AssetDataFact, opts: { forMatching?: boolean } = {}): CandidateIdentity {
  const refs: CandidateIdentity['refs'] = [];
  if (fact.reference) {
    const normalized = normalizeBusinessReference(fact.reference);
    refs.push({ kind: 'POLICY', value: fact.reference, normalized });
    if (opts.forMatching) refs.push({ kind: 'CONTRACT', value: fact.reference, normalized });
  }
  const role: FinancialComponentKind = fact.nature === 'DISPOSAL' ? 'PROCEED' : 'REALIZED_COST';
  return {
    candidateId: 0,
    candidateKey: `ASSET_DATA:${fact.nature}`,
    fileId: 0,
    established: true,
    confidence: 'certain',
    type: fact.nature as BusinessOperationTypeCode,
    status: 'REALIZED',
    role: null,
    summary: LIBELLES[fact.nature],
    provider: fact.provider,
    providerKey: normalizeProvider(fact.provider),
    assetIds: [assetId],
    targetAuthority: 'USER',
    equipmentIds: [],
    refs,
    dates: {
      plannedDate: null,
      // C11.1 : un contrat d'assurance saisi n'a pas de date d'effet connue.
      startDate: null,
      realizedDate: fact.nature === 'CONTRACT' ? null : fact.date,
      endDate: null,
    },
    hints: fact.amountMinor !== null && fact.nature !== 'CONTRACT'
      ? [{ role, amountMinor: fact.amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: fact.date, periodStart: null, periodEnd: null }]
      : [],
    structured: { nature: fact.nature, dateBasis: fact.dateBasis },
  };
}

/** Composante du fait porté par la donnée structurée, selon la nature. */
const FAIT_STRUCTURE: Partial<Record<BusinessOperationTypeCode, FinancialComponentKind>> = {
  ACQUISITION: 'REALIZED_COST',
  DISPOSAL: 'PROCEED',
};

/**
 * Autorité de la donnée saisie sur le fait qu'elle porte (9.3, B9 ; C7.1,
 * C7.6, C12.1) — pure, appliquée à l'état consolidé d'une Opération :
 *   · date : la date saisie (champ, pas le repli « passage au statut ») de
 *     l'acquisition / de la cession prime sur une date documentaire ; le
 *     repli ne sert qu'à défaut de toute autre date (C11.1) ;
 *   · montant : le prix d'achat (REALIZED_COST) / de vente (PROCEED) saisi
 *     et le montant documentaire du même rôle sont LE MÊME fait économique.
 *     Montant égal → une seule composante, soutenue par les deux sources.
 *     Montant différent → la saisie prime, la composante documentaire de ce
 *     rôle n'est pas comptée (jamais 2 prix pour un même achat).
 */
export function applyStructuredAuthority(
  state: ConsolidatedState, sources: readonly SourceContribution[],
): ConsolidatedState {
  const structurees = sources.filter((s) => s.identity.structured);
  if (!structurees.length || state.type === null) return state;
  const out: ConsolidatedState = { ...state, components: [...state.components], amountConflicts: [...state.amountConflicts] };

  if (state.type === 'ACQUISITION' || state.type === 'DISPOSAL') {
    const saisies = structurees.filter((s) => s.identity.structured?.nature === state.type);
    const datee = saisies.find((s) => s.identity.dates.realizedDate && s.identity.structured?.dateBasis !== 'STATUS_CHANGE');
    if (datee && state.status === 'REALIZED') out.realizedDate = datee.identity.dates.realizedDate;
    const repli = saisies.find((s) => s.identity.dates.realizedDate);
    if (out.realizedDate === null && repli && state.status === 'REALIZED') out.realizedDate = repli.identity.dates.realizedDate;

    const kind = FAIT_STRUCTURE[state.type]!;
    const ids = new Set(saisies.map((s) => s.sourceId));
    const saisie = out.components.find((c) => c.kind === kind && c.sourceIds.some((id) => ids.has(id)) && c.sourceIds.every((id) => ids.has(id)));
    if (saisie) {
      const docs = out.components.filter((c) => c !== saisie && c.kind === kind);
      const egale = docs.find((c) => c.amountMinor === saisie.amountMinor && c.currency === saisie.currency);
      if (egale) {
        egale.sourceIds = [...new Set([...egale.sourceIds, ...saisie.sourceIds])];
        out.components = out.components.filter((c) => c !== saisie);
      } else if (docs.length) {
        const ecartees = new Set(docs.map((c) => c.fingerprint));
        out.components = out.components.filter((c) => !ecartees.has(c.fingerprint));
        out.amountConflicts = out.amountConflicts.filter((c) => !ecartees.has(c.fingerprint));
      }
    }
  }
  return out;
}

/** Contribution consolidée d'une source ASSET_DATA (null : la donnée n'établit plus cette réalité). */
export function assetDataContribution(sourceId: number, row: AssetDataRow, nature: string): SourceContribution | null {
  if (!(ASSET_DATA_NATURES as readonly string[]).includes(nature)) return null;
  const fact = assetDataFacts(row)[nature as AssetDataNature];
  if (!fact) return null;
  return { sourceId, identity: assetDataIdentity(Number(row.id), fact) };
}
