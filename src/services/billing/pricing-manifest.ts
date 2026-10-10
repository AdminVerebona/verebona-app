/**
 * Référentiel tarifaire UNIQUE et versionné dans le code — CDC lookup_key V4,
 * LK-101, LK-85, EX-001 (`candidate_revision`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SEUL ENDROIT OÙ FIGURENT LES MONTANTS DE VENTE
 *
 * Pour changer un prix : modifier ici le montant (centimes TTC), puis
 * déployer. La tâche planifiée `stripe-catalog-publish` compare ce manifeste
 * à la révision active, crée le(s) nouveau(x) Price sous le produit existant,
 * transfère la clé stable, valide le catalogue complet et le portail, puis
 * active la nouvelle révision (voir `catalog-publication.service.ts`).
 * Aucun Price n'est créé à la main dans Stripe, aucune variable STRIPE_PRICE_*.
 *
 * Ces constantes sont une CANDIDATE : un déploiement ne les rend jamais
 * visibles à lui seul (LK-104, EX-001). Les vues et Checkout lisent la
 * révision ACTIVE persistée — jamais ce fichier. Module serveur : un test
 * interdit son import depuis un composant client.
 *
 * Les mentions « 2 mois offerts » et les pourcentages d'économie sont HORS
 * périmètre (LK-115, EX-038) : rien ici ne les calcule.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { CATALOG_COUPLES, type BillingPeriod, type PlanCode } from '@/lib/billing/plan-catalog';

export interface ManifestEntry {
  /** Montant TTC en centimes (entier > 0). */
  unitAmountCents: number;
  currency: 'eur';
  /** Montant TTC : `inclusive` (LK-14). */
  taxBehavior: 'inclusive';
}

/** Grille de la bascule V4 : 3,90/39 €, 6,90/69 €, 9,90/99 € TTC. */
export const PRICING_MANIFEST: Readonly<Record<PlanCode, Readonly<Record<BillingPeriod, ManifestEntry>>>> = {
  standard: {
    monthly: { unitAmountCents: 390, currency: 'eur', taxBehavior: 'inclusive' },
    yearly: { unitAmountCents: 3900, currency: 'eur', taxBehavior: 'inclusive' },
  },
  premium: {
    monthly: { unitAmountCents: 690, currency: 'eur', taxBehavior: 'inclusive' },
    yearly: { unitAmountCents: 6900, currency: 'eur', taxBehavior: 'inclusive' },
  },
  premium_duo: {
    monthly: { unitAmountCents: 990, currency: 'eur', taxBehavior: 'inclusive' },
    yearly: { unitAmountCents: 9900, currency: 'eur', taxBehavior: 'inclusive' },
  },
};

/** Produits logiques (création seulement si aucun produit approuvé n'existe, LK-03). */
export const PLAN_PRODUCT_DEFINITIONS: Readonly<Record<PlanCode, { name: string; description: string }>> = {
  standard: { name: 'Verebona Standard', description: "L'essentiel pour organiser vos biens et vos documents." },
  premium: { name: 'Verebona Premium', description: 'Toute la puissance de Verebona.' },
  premium_duo: { name: 'Verebona Premium Duo', description: 'Toute la puissance de Verebona, à deux.' },
};

/**
 * Révision candidate : empreinte déterministe du manifeste. Change dès qu'un
 * montant, une devise ou un traitement fiscal change ; jamais autrement.
 */
export function manifestRevision(manifest: typeof PRICING_MANIFEST = PRICING_MANIFEST): string {
  const canonical = CATALOG_COUPLES.map((c) => {
    const e = manifest[c.planCode][c.billingPeriod];
    return [c.lookupKey, e.unitAmountCents, e.currency, c.interval, 1, e.taxBehavior].join('|');
  }).join('\n');
  return `mf_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/** Contrôle de cohérence du manifeste (montant entier strictement positif). */
export function validateManifest(manifest: typeof PRICING_MANIFEST = PRICING_MANIFEST): string[] {
  const issues: string[] = [];
  for (const c of CATALOG_COUPLES) {
    const e = manifest[c.planCode]?.[c.billingPeriod];
    if (!e) { issues.push(`${c.lookupKey} : entrée absente`); continue; }
    if (!Number.isInteger(e.unitAmountCents) || e.unitAmountCents <= 0) issues.push(`${c.lookupKey} : montant invalide`);
    if (e.currency !== 'eur') issues.push(`${c.lookupKey} : devise ${e.currency}`);
  }
  return issues;
}
