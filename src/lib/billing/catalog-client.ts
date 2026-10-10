/**
 * Catalogue public côté NAVIGATEUR — CDC lookup_key V4, LK-29 à LK-36.
 *
 * Types et formats du contrat `GET /api/billing/catalog`, sans aucun import
 * serveur. Aucune grille de secours : un montant non chargé s'affiche
 * comme tel (LK-28, TC-61) — jamais un prix codé en dur.
 */
import { formatEuroCents, type BillingPeriod, type PlanCode } from './plan-catalog';

export interface CatalogOffer {
  plan_code: PlanCode;
  billing_period: BillingPeriod;
  unit_amount_cents: number;
  currency: 'eur';
  interval: 'month' | 'year';
  interval_count: 1;
  price_revision: string;
  available: boolean;
  tax_included: boolean;
}

export interface BillingCatalogResponse {
  catalog_version: string | null;
  verified_at: string | null;
  status: 'ok' | 'stale' | 'unavailable' | 'updating';
  purchasable: boolean;
  offers: CatalogOffer[];
}

export function findOffer(catalog: BillingCatalogResponse | null, plan: string, period: BillingPeriod): CatalogOffer | null {
  if (!catalog) return null;
  const code = plan.toLowerCase();
  return catalog.offers.find((o) => o.plan_code === code && o.billing_period === period && o.available) ?? null;
}

/** « 3,90 € » — montant seul. */
export function offerAmount(offer: Pick<CatalogOffer, 'unit_amount_cents'>): string {
  return formatEuroCents(offer.unit_amount_cents);
}

/** « par mois » / « par an ». */
export function periodSuffix(period: BillingPeriod): string {
  return period === 'yearly' ? 'par an' : 'par mois';
}

/** Mention de facturation : mensuel réel, annuel facturé en une fois (LK-32). */
export function billingMention(offer: Pick<CatalogOffer, 'billing_period' | 'tax_included'>): string {
  const ttc = offer.tax_included ? 'TTC' : '';
  return offer.billing_period === 'yearly' ? `${ttc}${ttc ? ', ' : ''}facturé en une fois` : ttc;
}

/** Réponse 409 d'un parcours de paiement : tarif à reconfirmer (LK-34). */
export interface PriceConfirmationPayload {
  code: 'PRICE_CHANGED' | 'PRICE_CONFIRMATION_REQUIRED';
  message: string;
  offer: CatalogOffer;
}

export function asPriceConfirmation(body: unknown): PriceConfirmationPayload | null {
  const b = body as Partial<PriceConfirmationPayload> | null;
  if (!b || (b.code !== 'PRICE_CHANGED' && b.code !== 'PRICE_CONFIRMATION_REQUIRED') || !b.offer?.price_revision) return null;
  return b as PriceConfirmationPayload;
}

/** Même lecture depuis une erreur `ApiClientError` (offre portée par `details`). */
export function priceConfirmationFromError(error: unknown): PriceConfirmationPayload | null {
  const e = error as { code?: string; details?: { offer?: CatalogOffer }; serverMessage?: string; message?: string } | null;
  if (!e) return null;
  return asPriceConfirmation({ code: e.code, message: e.serverMessage ?? e.message ?? '', offer: e.details?.offer });
}
