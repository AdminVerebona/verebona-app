/**
 * Règles d'offre du compte — `ProductRuleProvider`, CDC 15 T2-06 (lot 15).
 *
 * PRODUCT_PLAN_LIMIT attend des sources `product_rule` : aucune n'était
 * produite. Ce fournisseur les construit depuis les DROITS EFFECTIFS
 * (`entitlements.service` : offre, statut, quotas, fonctions Premium, mode
 * restreint), l'état de l'essai (`trial.service`) et l'usage réel (biens,
 * documents, utilisateurs). Aucune donnée de paiement.
 *
 * Fournisseur destiné à Y (branchement dans l'adaptateur). Borné au compte.
 */
import { pgClient } from '@/db';
import type { RetrievedSource } from '../types/sources';

export interface ProductRuleData {
  plan: 'trial' | 'standard' | 'premium' | 'premium_duo' | 'none';
  status: string;
  quotas: { maxAssets: number; maxDocuments: number; maxUsers: number };
  premiumFeatures: boolean;
  canWrite: boolean;
  isRestricted: boolean;
  trial: { status: 'none' | 'active' | 'expired' | 'converted'; endsAt: string | null; daysRemaining: number | null };
  usage: { assets: number; documents: number; users: number };
}

const PLAN_LABELS: Record<ProductRuleData['plan'], string> = {
  trial: 'Essai gratuit', standard: 'Standard', premium: 'Premium', premium_duo: 'Premium Duo', none: 'Aucune offre active',
};

const quota = (used: number, max: number, unite: string) =>
  `${used} ${unite}${used > 1 ? 's' : ''} sur ${max} autorisé${max > 1 ? 's' : ''}${used >= max ? ' (limite atteinte)' : ''}`;

/** Sources `product_rule` (pure, testée) : offre, quotas, essai, fonctions. */
export function productRuleSources(d: ProductRuleData): RetrievedSource[] {
  const out: RetrievedSource[] = [];
  const src = (code: string, title: string, content: string, meta: RetrievedSource['meta'] = {}): RetrievedSource =>
    ({ id: `product_rule:${code}`, type: 'product_rule', title, content, relevanceScore: 1, meta: { ruleCode: code, ...meta } });
  out.push(src('plan', 'Votre offre', `${PLAN_LABELS[d.plan]}${d.isRestricted ? ' — compte en mode restreint : consultation et export uniquement' : ''}.`,
    { plan: d.plan, status: d.status, restricted: d.isRestricted }));
  if (d.plan !== 'none') {
    out.push(src('quota_assets', 'Biens', quota(d.usage.assets, d.quotas.maxAssets, 'bien'), { used: d.usage.assets, limit: d.quotas.maxAssets }));
    out.push(src('quota_documents', 'Documents', quota(d.usage.documents, d.quotas.maxDocuments, 'document'), { used: d.usage.documents, limit: d.quotas.maxDocuments }));
    out.push(src('quota_users', 'Utilisateurs', quota(d.usage.users, d.quotas.maxUsers, 'utilisateur'), { used: d.usage.users, limit: d.quotas.maxUsers }));
  }
  out.push(src('premium_features', 'Fonctions Premium',
    d.premiumFeatures
      ? 'Incluses : questions à Verebona, synchronisation de l’agenda, dossiers prêts à transmettre.'
      : 'Non incluses dans votre offre : questions à Verebona, synchronisation de l’agenda, dossiers prêts à transmettre.',
    { included: d.premiumFeatures }));
  if (d.trial.status === 'active') {
    out.push(src('trial', 'Essai gratuit', `En cours : se termine le ${d.trial.endsAt?.slice(0, 10)} (${d.trial.daysRemaining} jour${(d.trial.daysRemaining ?? 0) > 1 ? 's' : ''} restant${(d.trial.daysRemaining ?? 0) > 1 ? 's' : ''}).`,
      { endsAt: d.trial.endsAt, daysRemaining: d.trial.daysRemaining }));
  } else if (d.trial.status === 'expired') {
    out.push(src('trial', 'Essai gratuit', `Terminé le ${d.trial.endsAt?.slice(0, 10)} : choisissez une offre pour continuer à enrichir votre compte.`, { endsAt: d.trial.endsAt }));
  }
  return out;
}

/** Données d'offre du compte (droits effectifs, essai, usage). */
export async function loadProductRuleData(accountId: number, now: Date = new Date()): Promise<ProductRuleData> {
  const [{ getEntitlements }, { getTrialState }] = await Promise.all([
    import('@/services/entitlements.service'),
    import('@/services/trial.service'),
  ]);
  const [ent, trial, usage] = await Promise.all([
    getEntitlements(accountId, now),
    getTrialState(accountId, now),
    pgClient.unsafe(
      `SELECT (SELECT count(*)::int FROM assets WHERE account_id = $1 AND deleted_at IS NULL) AS assets,
              (SELECT count(*)::int FROM asset_files WHERE account_id = $1 AND deleted_at IS NULL) AS documents,
              (SELECT count(*)::int FROM account_memberships WHERE account_id = $1 AND status = 'active') AS users`,
      [accountId] as never[],
    ) as unknown as Promise<Array<{ assets: number; documents: number; users: number }>>,
  ]);
  const u = usage[0] ?? { assets: 0, documents: 0, users: 0 };
  return {
    plan: ent.plan, status: ent.status, quotas: ent.quotas, premiumFeatures: ent.premiumFeatures,
    canWrite: ent.canWrite, isRestricted: ent.isRestricted,
    trial: {
      status: trial.status,
      endsAt: 'endsAt' in trial ? trial.endsAt.toISOString() : null,
      daysRemaining: trial.status === 'active' ? trial.daysRemaining : null,
    },
    usage: { assets: Number(u.assets), documents: Number(u.documents), users: Number(u.users) },
  };
}

/** Fournisseur `product_rule` (T2-06) : sources de l'offre effective du compte. */
export const ProductRuleProvider = {
  async sources(accountId: number, now: Date = new Date()): Promise<RetrievedSource[]> {
    return productRuleSources(await loadProductRuleData(accountId, now));
  },
};
