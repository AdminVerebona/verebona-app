/**
 * Lot 111I — TCO : justificatif d'achat rattaché à PLUSIEURS équipements
 * (règle pure, module isolé ; seul appelant : `model.ts`).
 *
 * Le moteur compte une dépense documentaire UNE fois au niveau du bien :
 * une ligne par montant du document, jamais une par équipement rattaché (le
 * périmètre `readEconomicDocuments` sélectionne le document par EXISTS, pas
 * par jointure). Aucune répartition entre équipements n'est créée : la règle
 * existante n'en prévoit pas (seule la ventilation multi-BIENS établie par T1
 * existe, lot 75D E).
 *
 * Risque propre au rattachement multiple : une facture couvrant deux
 * équipements (ex. 1 000 € = four 600 € + micro-onde 400 €) dont chaque
 * fiche porte son prix d'achat. La règle historique (lot 71A / 75D F)
 * rapproche le prix d'un équipement d'UNE facture de MÊME montant ; ici
 * aucun montant n'est égal — sans ce module, facture ET prix des fiches
 * seraient comptés (1 000 + 600 + 400).
 *
 * Règle (identité ÉTABLIE, jamais le montant seul d'un équipement) : une
 * facture d'achat RETENUE, rattachée à un ensemble E d'au moins deux
 * équipements du bien, couvre les prix des fiches de E si
 *   · CHAQUE équipement de E a un prix d'achat sur sa fiche (en euros),
 *   · la SOMME de ces prix est EXACTEMENT le montant retenu de la facture,
 *   · chaque date d'achat d'équipement est compatible avec celle de la
 *     facture (même fenêtre que le rapprochement d'achat, `purchaseDatesCompatible`),
 *   · aucune autre facture candidate ne revendique le même équipement
 *     (ambiguïté : rien n'est rapproché, comportement antérieur).
 * Les prix couverts deviennent des doublons de la facture (comptés 0).
 */
import { purchaseDatesCompatible } from './fact-matching';

export interface MultiEquipmentPurchase {
  fileId: number;
  /** Montant retenu de la ligne (euros, centimes). */
  eurMinor: number | null;
  date: string | null;
  linkedEquipmentIds: readonly number[];
}

export interface EquipmentPriceFact {
  equipmentId: number;
  /** Prix de la fiche en euros (centimes), null si non convertible. */
  eurMinor: number | null;
  date: string | null;
}

/** Équipement → facture multi-équipements qui couvre son prix (pure). */
export function multiEquipmentPurchaseCoverage(purchases: readonly MultiEquipmentPurchase[], prices: readonly EquipmentPriceFact[]): Map<number, number> {
  const prix = new Map(prices.filter((p) => p.eurMinor != null && p.eurMinor > 0).map((p) => [p.equipmentId, p]));
  const proposees = new Map<number, number[]>();
  const retenues: Array<{ fileId: number; ids: number[] }> = [];
  for (const f of purchases) {
    const ids = [...new Set(f.linkedEquipmentIds)];
    if (ids.length < 2 || f.eurMinor == null || f.eurMinor <= 0) continue;
    if (!ids.every((id) => prix.has(id))) continue;
    const somme = ids.reduce((s, id) => s + (prix.get(id)!.eurMinor as number), 0);
    if (somme !== f.eurMinor) continue;
    if (!ids.every((id) => purchaseDatesCompatible(f.date, prix.get(id)!.date))) continue;
    retenues.push({ fileId: f.fileId, ids });
    for (const id of ids) proposees.set(id, [...new Set([...(proposees.get(id) ?? []), f.fileId])]);
  }
  // Une facture dont UN équipement est revendiqué par une autre facture n'est rapprochée pour aucun (tout ou rien).
  const out = new Map<number, number>();
  for (const f of retenues) {
    if (f.ids.every((id) => proposees.get(id)!.length === 1)) for (const id of f.ids) out.set(id, f.fileId);
  }
  return out;
}
