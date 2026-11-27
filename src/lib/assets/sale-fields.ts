/**
 * Vente réalisée d'un bien — règles d'affichage et de saisie (lot 43, O4 ;
 * décision PO Q5 du 11/10 ; CDC Opérations V1 B13.6, B18, C7.6, C18).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   VENDU     date de vente ET prix de vente réalisé (facultatifs) ;
 *   TRANSMIS  date seule : une transmission est une cession SANS prix ;
 *   autres    rien (aucune vente réalisée).
 *
 * Les deux valeurs sont des clés canoniques de la fiche (`saleDate`,
 * `salePrice` en euros, saisie seule). Elles sont demandées dans une petite
 * fenêtre au passage du bien à VENDU / TRANSMIS (« À traiter », desktop et
 * mobile) puis restent modifiables dans la fiche (section « Informations
 * générales »). Le prix SOUHAITÉ (informations commerciales) et la valeur
 * estimée sont d'autres données (C18).
 *
 * Module PUR : importable côté client.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { MONEY_INPUT, parseNumberInput } from '@/lib/number-input';

/** Statuts d'un bien sorti par une cession — #849 : TRANSMIS seul (VENDU retiré du référentiel). */
const DISPOSAL_ASSET_STATUSES = ['TRANSMIS'] as const;

export function isDisposalStatus(status: unknown): boolean {
  return typeof status === 'string' && (DISPOSAL_ASSET_STATUSES as readonly string[]).includes(status);
}

/**
 * #849 : le prix de vente réalisé (historique d'un ancien VENDU, ou cession
 * connue) reste affiché pour un bien TRANSMIS — jamais exigé.
 */
export function salePriceApplies(status: unknown): boolean {
  return status === 'TRANSMIS';
}

export interface SaleDetailsPrompt {
  status: 'VENDU' | 'TRANSMIS';
  title: string;
  description: string;
  dateLabel: string;
  /** Prix demandé (vente seulement). */
  askPrice: boolean;
}

/**
 * Fenêtre à proposer après un passage de statut (null : aucune).
 *
 * Carte #849 (A3) — règle remplacée (lot 43) : le passage manuel à TRANSMIS
 * est DIRECT, sans fenêtre demandant date, prix ou cause. La vente reste une
 * Opération de cession (date, prix, justificatifs si connus). Plus aucune
 * fenêtre n'est proposée ; le modèle ci-dessous reste lisible pour les
 * anciennes valeurs, jamais déclenché.
 */
export function saleDetailsPrompt(status: unknown): SaleDetailsPrompt | null {
  void status;
  return null;
}

/** Ancien modèle de la fenêtre (lot 43), conservé pour référence — jamais proposé depuis #849. */
export function legacySaleDetailsPrompt(status: unknown): SaleDetailsPrompt | null {
  if (status === 'VENDU') {
    return {
      status, askPrice: true, dateLabel: 'Date de vente',
      title: 'Vente enregistrée',
      description: 'Indiquez si vous le souhaitez la date et le prix de vente réels. Ces informations sont facultatives et restent modifiables dans la fiche du bien.',
    };
  }
  if (status === 'TRANSMIS') {
    return {
      status, askPrice: false, dateLabel: 'Date de transmission',
      title: 'Transmission enregistrée',
      description: 'Indiquez si vous le souhaitez la date de la transmission. Cette information est facultative et reste modifiable dans la fiche du bien.',
    };
  }
  return null;
}

/**
 * Champs à envoyer à la fiche (`PATCH /api/assets/:id/details/common`) :
 * seulement les valeurs saisies — un champ laissé vide n'efface rien.
 * Prix en euros (clé canonique `salePrice`), nombre ≥ 0 ; date AAAA-MM-JJ.
 */
export function saleDetailsPatch(
  prompt: Pick<SaleDetailsPrompt, 'askPrice'>,
  input: { date: string; price: string },
): { fields: Record<string, string | number> } | { error: string } | null {
  const fields: Record<string, string | number> = {};
  const date = input.date.trim();
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Date invalide.' };
    fields.saleDate = date;
  }
  // Lot 58A : lecture partagée du champ montant (virgule décimale, espaces
  // de milliers) ; ambigu ou invalide → refus explicite, jamais d'arrondi.
  if (prompt.askPrice) {
    const lu = parseNumberInput(input.price, MONEY_INPUT);
    if (!lu.ok) return { error: `Prix invalide : ${lu.error}` };
    if (lu.value !== null) fields.salePrice = lu.value;
  }
  return Object.keys(fields).length ? { fields } : null;
}

/**
 * Fiche copiée chez un NOUVEAU détenteur (transmission acceptée) : la vente
 * réalisée de l'ancien détenteur n'est pas la sienne — `saleDate`,
 * `salePrice` et leurs métadonnées (`__origin`, `__updatedAt`…) sont retirés.
 */
export function withoutSaleFields<T extends Record<string, unknown>>(kc: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kc)) {
    if (/^(saleDate|salePrice)(__|_origin$|$)/.test(k)) continue;
    out[k] = v;
  }
  return out as T;
}
