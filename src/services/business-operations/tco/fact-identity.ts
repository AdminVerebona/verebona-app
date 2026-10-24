/**
 * Lot 78B — ticket P1 « Opérations & TCO — identité économique » §3 :
 * attribution des composantes à LEURS justificatifs, doublons financiers à
 * l'intérieur d'une Opération, pertinence d'une dépense pour le coût de
 * possession d'un bien. PUR (aucun accès base), consommé par `computeTco`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE RÈGLE PAR COMMERÇANT, DOCUMENT OU EXEMPLE
 *
 * Les décisions reposent sur la nature économique des faits et leurs
 * relations PERSISTÉES : nature de la composante, montant, devise, cible,
 * justificatifs qui la portent (`business_operation_financial_component_sources`),
 * références de facture de ces justificatifs, périodes, type de l'Opération,
 * catégorie du bien, liens Opération ↔ bien / équipement et leur autorité.
 *
 * §3B — UNE SOMME PORTÉE PAR PLUSIEURS JUSTIFICATIFS D'UNE MÊME OPÉRATION
 * n'est comptée qu'une fois SANS preuve de transactions distinctes. Preuves
 * de transactions distinctes (une seule suffit) :
 *   · un même justificatif porte les deux montants (deux lignes d'un document) ;
 *   · des périodes renseignées et différentes (échéances) ;
 *   · une relation récurrente (contrat, financement) et des dates différentes ;
 *   · des références de facture différentes sur leurs justificatifs ;
 *   · une composante sans justificatif documentaire (saisie, fiche, sinistre :
 *     la consolidation T3 en arbitre déjà) ou une provenance non lue.
 * Sinon : comptée UNE fois (la composante la mieux justifiée), l'autre reste
 * CONNUE, tracée, signalée (« doublon présumé »), jamais additionnée.
 * La différence de date SEULE ne prouve rien (un acte et l'attestation qui en
 * reprend le prix des années plus tard décrivent la même vente).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationTypeCode } from '../model';
import type { LedgerComponent } from '../finance/engine';

/** Provenance lue d'une composante active (service TCO). */
export interface ComponentProvenance {
  /** Justificatifs (fichiers) des sources DOCUMENT ACTIVES qui la portent. */
  documentFileIds: readonly number[];
  /** Justificatifs dont la source a été RETIRÉE de l'Opération (source inactive). */
  withdrawnFileIds: readonly number[];
  /** Natures des autres sources actives (ASSET_DATA, AGENDA, CLAIM_FORM, USER, MIGRATION…). */
  otherSourceKinds: readonly string[];
  /** Références de facture (normalisées) portées par ses sources actives. */
  invoiceRefs: readonly string[];
  /**
   * Un de ses justificatifs actifs porte-t-il ce montant (montant du document
   * ou indice T1 de même montant) ? null : aucun justificatif actif.
   */
  explained: boolean | null;
  /**
   * Un de ses justificatifs actifs est la preuve ACTIVE du prix d'achat d'un
   * AUTRE bien (T1 y a lu le prix d'acquisition de cet autre bien).
   */
  otherAssetAcquisition?: boolean;
  /**
   * Lot 85A (O-9) : identités STABLES de ses sources non documentaires
   * reproductibles (`tcoSourceIdentity` : donnée structurée du bien ou de
   * l'équipement, élément d'agenda) — elles survivent à une reconstruction des
   * Opérations (O-2), contrairement à l'identifiant d'Opération.
   */
  otherSourceKeys?: readonly string[];
}

/** Relation récurrente : des échéances de même montant à des dates différentes sont des paiements distincts. */
const RECURRENTES: ReadonlySet<string> = new Set<BusinessOperationTypeCode>(['CONTRACT', 'FINANCING']);

const jour = (d: string | null | undefined): string | null => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/** Preuve de transactions distinctes entre deux composantes de même nature, montant, devise et cible (pure). */
export function distinctTransactions(
  a: LedgerComponent, b: LedgerComponent, pa: ComponentProvenance | undefined, pb: ComponentProvenance | undefined,
  operationType: BusinessOperationTypeCode | null,
): boolean {
  // Provenance non lue, ou composante non documentaire : aucune présomption (la consolidation T3 arbitre).
  if (!pa || !pb || !pa.documentFileIds.length || !pb.documentFileIds.length) return true;
  // Un même justificatif porte les deux montants : deux lignes réelles du document.
  if (pa.documentFileIds.some((f) => pb.documentFileIds.includes(f))) return true;
  const [sa, ea, sb, eb] = [jour(a.periodStart), jour(a.periodEnd), jour(b.periodStart), jour(b.periodEnd)];
  if ((sa || ea) && (sb || eb) && (sa !== sb || ea !== eb)) return true;
  if (operationType && RECURRENTES.has(operationType)) {
    const [da, db] = [jour(a.economicDate), jour(b.economicDate)];
    if (da && db && da !== db) return true;
  }
  if (pa.invoiceRefs.length && pb.invoiceRefs.length && !pa.invoiceRefs.some((r) => pb.invoiceRefs.includes(r))) return true;
  return false;
}

export interface PresumedDuplicate {
  /** Composante comptée à sa place. */
  keptComponentId: number;
  /** Justificatifs de la composante comptée (traçabilité). */
  keptFileIds: readonly number[];
}

/**
 * §3B — composantes d'UNE Opération présumées doublons d'une autre (pure).
 * `strength` : force de justification (preuve du prix, donnée de la fiche,
 * montant retrouvé sur le justificatif) — la mieux justifiée est comptée,
 * à égalité la plus ancienne.
 */
export function presumedDuplicateComponents(
  op: { typeCode: BusinessOperationTypeCode | null; components: readonly LedgerComponent[] },
  provenance: ReadonlyMap<number, ComponentProvenance>,
  strength: (componentId: number) => number = () => 0,
): Map<number, PresumedDuplicate> {
  const out = new Map<number, PresumedDuplicate>();
  const groupes = new Map<string, LedgerComponent[]>();
  for (const c of op.components) {
    if (c.kind === 'FORECAST_COST') continue; // une prévision n'est jamais comptée : rien à dédoublonner
    const k = [c.kind, String(c.currency).trim().toUpperCase(), c.amountMinor, c.targetAssetId ?? '', c.targetEquipmentId ?? ''].join('|');
    groupes.set(k, [...(groupes.get(k) ?? []), c]);
  }
  for (const g of groupes.values()) {
    if (g.length < 2) continue;
    const tries = [...g].sort((x, y) => strength(y.id) - strength(x.id) || x.id - y.id);
    const comptees: LedgerComponent[] = [];
    for (const c of tries) {
      const meme = comptees.find((k) => !distinctTransactions(c, k, provenance.get(c.id), provenance.get(k.id), op.typeCode));
      if (meme) out.set(c.id, { keptComponentId: meme.id, keptFileIds: provenance.get(meme.id)?.documentFileIds ?? [] });
      else comptees.push(c);
    }
  }
  return out;
}

/**
 * §3A — la composante n'est pas justifiée par SES justificatifs : aucun ne
 * porte son montant, ou tous ont été retirés de l'Opération (pure). Jamais
 * pour une composante non documentaire (saisie, fiche) ni sans provenance lue.
 */
export function unjustifiedComponent(p: ComponentProvenance | undefined): 'AMOUNT_NOT_ON_SOURCES' | 'SOURCES_WITHDRAWN' | null {
  if (!p) return null;
  if (p.documentFileIds.length) return p.explained === false ? 'AMOUNT_NOT_ON_SOURCES' : null;
  if (p.withdrawnFileIds.length && !p.otherSourceKinds.length) return 'SOURCES_WITHDRAWN';
  return null;
}

/**
 * §3C — un ACHAT relève-t-il du coût de possession du bien ? (pure)
 *
 * Un bien IMMOBILIER se possède avec son prix, ses frais d'acquisition, ses
 * travaux et entretiens, ses charges et impôts (taxe foncière), ses contrats
 * et son financement, et ses ÉQUIPEMENTS (incorporés, suivis comme tels).
 * L'achat d'un autre objet (mobilier, électroménager non suivi comme
 * équipement…) est une transaction INDÉPENDANTE : le rattacher au bien parce
 * que son justificatif y est classé, ou parce que T3 l'a rapproché du même
 * cycle de possession, ne l'incorpore pas automatiquement au coût du bien.
 * Il l'est si l'utilisateur a lui-même rattaché l'Opération au bien (lien
 * d'autorité USER) ou l'a rattachée à un équipement du bien.
 *
 * Un bien MOBILE (véhicule, objet) : un achat qui le cible est un accessoire
 * qui le suit (antivol, béquille, remorque) — compté (lots 61, 75D, inchangé).
 */
export function purchaseIsOwnershipCost(p: {
  assetCategory: string | null;
  /** L'achat concerne un équipement du bien (cible, lien, preuve du prix de l'équipement). */
  concernsEquipment: boolean;
  /** Frais d'acquisition (portée FEE) : coût de l'acquisition du bien, jamais un objet distinct. */
  acquisitionFee?: boolean;
  /** L'utilisateur a lui-même rattaché la dépense au bien. */
  userLinked?: boolean;
}): boolean {
  if (p.concernsEquipment || p.acquisitionFee || p.userLinked) return true;
  return p.assetCategory !== 'IMMOBILIER';
}
