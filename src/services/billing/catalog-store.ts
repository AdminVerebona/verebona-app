/**
 * Persistance PARTAGÉE du catalogue Stripe (migration 0306) — CDC lookup_key
 * V4 §7, LK-18, LK-24, LK-27, EX-001/002.
 *
 * Tout ce que les instances doivent voir de la même façon vit en base :
 * révision active, génération d'invalidation, état de publication, produits
 * approuvés, registre des versions, journal. Un cache mémoire d'instance ne
 * suffit pas (EC-11) — il n'est utilisé qu'au-dessus de ces lectures, borné.
 *
 * Interface `CatalogStore` : les services la reçoivent par injection ; les
 * tests unitaires utilisent un magasin en mémoire, les e2e la base réelle.
 */
import { pgClient } from '@/db';
import type { PlanCode } from '@/lib/billing/plan-catalog';
import type { CatalogSnapshot, ResolvedPrice } from './catalog-types';

export type PublicationState = 'PREPARED' | 'VALIDATING' | 'PUBLISHING' | 'READY' | 'ACTIVE' | 'FAILED' | 'RECOVERING' | 'SUPERSEDED';

export interface CatalogStateRow {
  catalogContext: string;
  stripeAccountId: string | null;
  livemode: boolean | null;
  activeRevision: string | null;
  activeSnapshot: CatalogSnapshot | null;
  previousRevision: string | null;
  previousSnapshot: CatalogSnapshot | null;
  verifiedAt: Date | null;
  generation: number;
  invalidatedAt: Date | null;
  publicationState: PublicationState;
  publicationRunId: number | null;
  publicationError: string | null;
  activatingUntil: Date | null;
  publishedManifestRevision: string | null;
  candidateManifestRevision: string | null;
  candidateFirstSeenAt: Date | null;
  portalConfigurationId: string | null;
  portalFingerprint: string | null;
  portalVerifiedAt: Date | null;
  backfillCompletedAt: Date | null;
  lastSyncError: string | null;
  updatedAt: Date | null;
}

export interface ApprovedProduct {
  planCode: PlanCode;
  stripeProductId: string;
  role: 'sale' | 'historical';
  source: string;
}

export interface PriceVersionRow {
  catalogContext: string;
  stripeAccountId: string | null;
  livemode: boolean | null;
  stripePriceId: string;
  stripeProductId: string;
  planCode: PlanCode;
  billingPeriod: 'monthly' | 'yearly';
  logicalLookupKey: string;
  observedLookupKey: string | null;
  unitAmountCents: number;
  currency: string;
  interval: 'month' | 'year';
  intervalCount: number;
  taxBehavior: string;
  priceRevision: string;
  stripeActive: boolean;
  source: string;
  firstSeenAt?: Date | null;
  lastVerifiedAt?: Date | null;
}

export type RunKind = 'sync' | 'backfill' | 'publish' | 'rollback' | 'revaluation';
export type RunState = PublicationState | 'DONE' | 'NOOP';

export interface CatalogRunRow {
  id: number;
  catalogContext: string;
  kind: RunKind;
  state: RunState;
  trigger: string;
  actor: string | null;
  codeVersion: string | null;
  manifestRevision: string | null;
  fromRevision: string | null;
  toRevision: string | null;
  dryRun: boolean;
  steps: Array<Record<string, unknown>>;
  createdPrices: Record<string, unknown>;
  transfers: Array<Record<string, unknown>>;
  report: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ActivationInput {
  context: string;
  stripeAccountId: string | null;
  livemode: boolean | null;
  snapshot: CatalogSnapshot;
  /** Garder l'ancienne révision comme point de retour arrière (changement réel). */
  keepPrevious: boolean;
  publishedManifestRevision?: string | null;
  versions: PriceVersionRow[];
  publicationState?: PublicationState;
  publicationRunId?: number | null;
}

export interface CatalogStore {
  getState(context: string): Promise<CatalogStateRow | null>;
  ensureState(context: string): Promise<CatalogStateRow>;
  /** Publie une révision : photographie + registre + miroirs `subscription_plans`, une transaction (§7.2). */
  activateSnapshot(input: ActivationInput): Promise<CatalogStateRow>;
  touchVerified(context: string, verifiedAt: Date, accountId: string | null, livemode: boolean | null): Promise<void>;
  invalidate(context: string): Promise<void>;
  setPublication(context: string, patch: { state: PublicationState; runId?: number | null; error?: string | null; activatingUntil?: Date | null }): Promise<void>;
  setCandidate(context: string, manifestRevision: string, now: Date): Promise<void>;
  setPortal(context: string, configurationId: string, fingerprint: string, verifiedAt: Date): Promise<void>;
  setBackfillCompleted(context: string, at: Date): Promise<void>;
  setSyncError(context: string, error: string | null): Promise<void>;
  listApprovedProducts(context: string): Promise<ApprovedProduct[]>;
  approveProduct(context: string, p: ApprovedProduct & { stripeAccountId?: string | null; livemode?: boolean | null }): Promise<'inserted' | 'exists' | 'conflict'>;
  findPriceVersion(context: string, priceId: string): Promise<PriceVersionRow | null>;
  upsertPriceVersion(row: PriceVersionRow): Promise<void>;
  listPriceVersions(context: string): Promise<PriceVersionRow[]>;
  createRun(r: { context: string; kind: RunKind; state: RunState; trigger: string; actor?: string | null; manifestRevision?: string | null; fromRevision?: string | null; dryRun?: boolean }): Promise<number>;
  updateRun(id: number, patch: Partial<Pick<CatalogRunRow, 'state' | 'toRevision' | 'createdPrices' | 'transfers' | 'report' | 'error'>> & { finished?: boolean; step?: Record<string, unknown> }): Promise<void>;
  getRun(id: number): Promise<CatalogRunRow | null>;
  listRuns(context: string, limit: number): Promise<CatalogRunRow[]>;
}

// ─── Implémentation PostgreSQL ───────────────────────────────────────────────

type Row = Record<string, unknown>;
type Exec = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

async function q<T = Row>(text: string, params: unknown[] = [], exec: Exec = pgClient as unknown as Exec): Promise<T[]> {
  return (await exec.unsafe(text, params as never[])) as T[];
}

const d = (v: unknown): Date | null => (v ? new Date(v as string) : null);
const j = <T>(v: unknown): T | null => (v == null ? null : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

function mapState(r: Row): CatalogStateRow {
  return {
    catalogContext: String(r.catalog_context),
    stripeAccountId: (r.stripe_account_id as string) ?? null,
    livemode: (r.livemode as boolean) ?? null,
    activeRevision: (r.active_revision as string) ?? null,
    activeSnapshot: j<CatalogSnapshot>(r.active_snapshot),
    previousRevision: (r.previous_revision as string) ?? null,
    previousSnapshot: j<CatalogSnapshot>(r.previous_snapshot),
    verifiedAt: d(r.verified_at),
    generation: Number(r.generation ?? 0),
    invalidatedAt: d(r.invalidated_at),
    publicationState: (r.publication_state as PublicationState) ?? 'ACTIVE',
    publicationRunId: r.publication_run_id == null ? null : Number(r.publication_run_id),
    publicationError: (r.publication_error as string) ?? null,
    activatingUntil: d(r.activating_until),
    publishedManifestRevision: (r.published_manifest_revision as string) ?? null,
    candidateManifestRevision: (r.candidate_manifest_revision as string) ?? null,
    candidateFirstSeenAt: d(r.candidate_first_seen_at),
    portalConfigurationId: (r.portal_configuration_id as string) ?? null,
    portalFingerprint: (r.portal_fingerprint as string) ?? null,
    portalVerifiedAt: d(r.portal_verified_at),
    backfillCompletedAt: d(r.backfill_completed_at),
    lastSyncError: (r.last_sync_error as string) ?? null,
    updatedAt: d(r.updated_at),
  };
}

function mapVersion(r: Row): PriceVersionRow {
  return {
    catalogContext: String(r.catalog_context),
    stripeAccountId: (r.stripe_account_id as string) ?? null,
    livemode: (r.livemode as boolean) ?? null,
    stripePriceId: String(r.stripe_price_id),
    stripeProductId: String(r.stripe_product_id),
    planCode: r.plan_code as PlanCode,
    billingPeriod: r.billing_period as 'monthly' | 'yearly',
    logicalLookupKey: String(r.logical_lookup_key),
    observedLookupKey: (r.observed_lookup_key as string) ?? null,
    unitAmountCents: Number(r.unit_amount_cents),
    currency: String(r.currency),
    interval: r.interval as 'month' | 'year',
    intervalCount: Number(r.interval_count ?? 1),
    taxBehavior: String(r.tax_behavior),
    priceRevision: String(r.price_revision),
    stripeActive: Boolean(r.stripe_active),
    source: String(r.source),
    firstSeenAt: d(r.first_seen_at),
    lastVerifiedAt: d(r.last_verified_at),
  };
}

function mapRun(r: Row): CatalogRunRow {
  return {
    id: Number(r.id),
    catalogContext: String(r.catalog_context),
    kind: r.kind as RunKind,
    state: r.state as RunState,
    trigger: String(r.trigger),
    actor: (r.actor as string) ?? null,
    codeVersion: (r.code_version as string) ?? null,
    manifestRevision: (r.manifest_revision as string) ?? null,
    fromRevision: (r.from_revision as string) ?? null,
    toRevision: (r.to_revision as string) ?? null,
    dryRun: Boolean(r.dry_run),
    steps: j<Array<Record<string, unknown>>>(r.steps) ?? [],
    createdPrices: j<Record<string, unknown>>(r.created_prices) ?? {},
    transfers: j<Array<Record<string, unknown>>>(r.transfers) ?? [],
    report: j<Record<string, unknown>>(r.report),
    error: (r.error as string) ?? null,
    startedAt: new Date(r.started_at as string),
    finishedAt: d(r.finished_at),
  };
}

const UPSERT_VERSION = `
  INSERT INTO stripe_price_versions
    (catalog_context, stripe_account_id, livemode, stripe_price_id, stripe_product_id, plan_code, billing_period,
     logical_lookup_key, observed_lookup_key, unit_amount_cents, currency, interval, interval_count, tax_behavior,
     price_revision, stripe_active, source, first_seen_at, last_verified_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), now())
  ON CONFLICT (catalog_context, stripe_price_id) DO UPDATE SET
    -- L'identité fonctionnelle (offre, périodicité, produit) n'est JAMAIS
    -- réaffectée par une simple observation (§7.1) : seules les données
    -- d'observation sont rafraîchies.
    observed_lookup_key = EXCLUDED.observed_lookup_key,
    stripe_active = EXCLUDED.stripe_active,
    stripe_account_id = COALESCE(stripe_price_versions.stripe_account_id, EXCLUDED.stripe_account_id),
    last_verified_at = now()`;

function versionParams(v: PriceVersionRow): unknown[] {
  return [v.catalogContext, v.stripeAccountId, v.livemode, v.stripePriceId, v.stripeProductId, v.planCode, v.billingPeriod,
    v.logicalLookupKey, v.observedLookupKey, v.unitAmountCents, v.currency, v.interval, v.intervalCount, v.taxBehavior,
    v.priceRevision, v.stripeActive, v.source];
}

export const pgCatalogStore: CatalogStore = {
  async getState(context) {
    const [r] = await q(`SELECT * FROM stripe_catalog_state WHERE catalog_context = $1`, [context]);
    return r ? mapState(r) : null;
  },
  async ensureState(context) {
    await q(`INSERT INTO stripe_catalog_state (catalog_context) VALUES ($1) ON CONFLICT DO NOTHING`, [context]);
    return (await this.getState(context))!;
  },
  async activateSnapshot(input) {
    const result = await pgClient.begin(async (tx) => {
      const exec = tx as unknown as Exec;
      await q(`INSERT INTO stripe_catalog_state (catalog_context) VALUES ($1) ON CONFLICT DO NOTHING`, [input.context], exec);
      const [cur] = await q(`SELECT active_revision, active_snapshot FROM stripe_catalog_state WHERE catalog_context = $1 FOR UPDATE`, [input.context], exec);
      for (const v of input.versions) await q(UPSERT_VERSION, versionParams(v), exec);
      const changed = cur?.active_revision !== input.snapshot.version;
      const [row] = await q(
        `UPDATE stripe_catalog_state SET
           stripe_account_id = COALESCE($2, stripe_account_id),
           livemode = COALESCE($3, livemode),
           previous_revision = CASE WHEN $4::boolean AND $5::boolean THEN active_revision ELSE previous_revision END,
           previous_snapshot = CASE WHEN $4::boolean AND $5::boolean THEN active_snapshot ELSE previous_snapshot END,
           active_revision = $6,
           active_snapshot = $7::jsonb,
           verified_at = $8::timestamptz,
           generation = generation + CASE WHEN $12::boolean THEN 1 ELSE 0 END,
           invalidated_at = NULL,
           published_manifest_revision = COALESCE($9, published_manifest_revision),
           publication_state = COALESCE($10, publication_state),
           publication_run_id = COALESCE($11, publication_run_id),
           publication_error = CASE WHEN $10 = 'ACTIVE' THEN NULL ELSE publication_error END,
           activating_until = NULL,
           last_sync_error = NULL,
           updated_at = now()
         WHERE catalog_context = $1
         RETURNING *`,
        [input.context, input.stripeAccountId, input.livemode, input.keepPrevious, changed && cur?.active_revision != null,
          input.snapshot.version, JSON.stringify(input.snapshot), input.snapshot.verifiedAt,
          input.publishedManifestRevision ?? null, input.publicationState ?? null, input.publicationRunId ?? null, changed],
        exec,
      );
      // Miroirs transitoires (§7.2) : alimentés EXCLUSIVEMENT ici, depuis
      // les objets Stripe validés. Jamais une source de facturation.
      for (const plan of ['standard', 'premium', 'premium_duo'] as const) {
        const m = input.snapshot.entries[`${plan}:monthly`];
        const y = input.snapshot.entries[`${plan}:yearly`];
        if (!m && !y) continue;
        await q(
          `UPDATE subscription_plans SET
             monthly_price_cents = COALESCE($2, monthly_price_cents),
             yearly_price_cents = COALESCE($3, yearly_price_cents),
             stripe_price_id_monthly = COALESCE($4, stripe_price_id_monthly),
             stripe_price_id_yearly = COALESCE($5, stripe_price_id_yearly),
             updated_at = now()
           WHERE code = $1`,
          [plan, m?.unitAmountCents ?? null, y?.unitAmountCents ?? null, m?.priceId ?? null, y?.priceId ?? null],
          exec,
        );
      }
      return row;
    });
    return mapState(result as unknown as Row);
  },
  async touchVerified(context, verifiedAt, accountId, livemode) {
    await q(
      `UPDATE stripe_catalog_state SET verified_at = $2::timestamptz, invalidated_at = NULL, last_sync_error = NULL,
         stripe_account_id = COALESCE($3, stripe_account_id), livemode = COALESCE($4, livemode), updated_at = now()
       WHERE catalog_context = $1`,
      [context, verifiedAt.toISOString(), accountId, livemode],
    );
  },
  async invalidate(context) {
    await q(`INSERT INTO stripe_catalog_state (catalog_context) VALUES ($1) ON CONFLICT DO NOTHING`, [context]);
    await q(`UPDATE stripe_catalog_state SET invalidated_at = now(), generation = generation + 1, updated_at = now() WHERE catalog_context = $1`, [context]);
  },
  async setPublication(context, patch) {
    await q(
      `UPDATE stripe_catalog_state SET publication_state = $2,
         publication_run_id = COALESCE($3, publication_run_id),
         publication_error = $4,
         activating_until = $5::timestamptz,
         generation = generation + 1,
         updated_at = now()
       WHERE catalog_context = $1`,
      [context, patch.state, patch.runId ?? null, patch.error ?? null, patch.activatingUntil ? patch.activatingUntil.toISOString() : null],
    );
  },
  async setCandidate(context, manifestRevision, now) {
    await q(
      `UPDATE stripe_catalog_state SET candidate_manifest_revision = $2,
         candidate_first_seen_at = CASE WHEN candidate_manifest_revision IS DISTINCT FROM $2 THEN $3::timestamptz ELSE candidate_first_seen_at END,
         updated_at = now()
       WHERE catalog_context = $1`,
      [context, manifestRevision, now.toISOString()],
    );
  },
  async setPortal(context, configurationId, fingerprint, verifiedAt) {
    await q(
      `UPDATE stripe_catalog_state SET portal_configuration_id = $2, portal_fingerprint = $3, portal_verified_at = $4::timestamptz, updated_at = now()
       WHERE catalog_context = $1`,
      [context, configurationId, fingerprint, verifiedAt.toISOString()],
    );
  },
  async setBackfillCompleted(context, at) {
    await q(`UPDATE stripe_catalog_state SET backfill_completed_at = $2::timestamptz, updated_at = now() WHERE catalog_context = $1`, [context, at.toISOString()]);
  },
  async setSyncError(context, error) {
    await q(`UPDATE stripe_catalog_state SET last_sync_error = $2, updated_at = now() WHERE catalog_context = $1`, [context, error]);
  },
  async listApprovedProducts(context) {
    const rows = await q(`SELECT plan_code, stripe_product_id, role, source FROM stripe_catalog_products WHERE catalog_context = $1 ORDER BY id`, [context]);
    return rows.map((r) => ({ planCode: r.plan_code as PlanCode, stripeProductId: String(r.stripe_product_id), role: r.role as 'sale' | 'historical', source: String(r.source) }));
  },
  async approveProduct(context, p) {
    const [existing] = await q(`SELECT plan_code, role FROM stripe_catalog_products WHERE catalog_context = $1 AND stripe_product_id = $2`, [context, p.stripeProductId]);
    if (existing) {
      if (existing.plan_code !== p.planCode) return 'conflict';
      if (p.role === 'sale' && existing.role !== 'sale') {
        try {
          await q(`UPDATE stripe_catalog_products SET role = 'sale', updated_at = now() WHERE catalog_context = $1 AND stripe_product_id = $2`, [context, p.stripeProductId]);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') return 'conflict';
          throw e;
        }
      }
      return 'exists';
    }
    try {
      await q(
        `INSERT INTO stripe_catalog_products (catalog_context, stripe_account_id, livemode, plan_code, stripe_product_id, role, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [context, p.stripeAccountId ?? null, p.livemode ?? null, p.planCode, p.stripeProductId, p.role, p.source],
      );
      return 'inserted';
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return 'conflict';
      throw e;
    }
  },
  async findPriceVersion(context, priceId) {
    const [r] = await q(`SELECT * FROM stripe_price_versions WHERE catalog_context = $1 AND stripe_price_id = $2`, [context, priceId]);
    return r ? mapVersion(r) : null;
  },
  async upsertPriceVersion(row) {
    await q(UPSERT_VERSION, versionParams(row));
  },
  async listPriceVersions(context) {
    const rows = await q(`SELECT * FROM stripe_price_versions WHERE catalog_context = $1 ORDER BY plan_code, billing_period, first_seen_at`, [context]);
    return rows.map(mapVersion);
  },
  async createRun(r) {
    const [row] = await q<{ id: number }>(
      `INSERT INTO stripe_catalog_runs (catalog_context, kind, state, trigger, actor, code_version, manifest_revision, from_revision, dry_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [r.context, r.kind, r.state, r.trigger, r.actor ?? null, codeVersion(), r.manifestRevision ?? null, r.fromRevision ?? null, r.dryRun ?? false],
    );
    return Number(row.id);
  },
  async updateRun(id, patch) {
    await q(
      `UPDATE stripe_catalog_runs SET
         state = COALESCE($2, state),
         to_revision = COALESCE($3, to_revision),
         created_prices = COALESCE($4::jsonb, created_prices),
         transfers = COALESCE($5::jsonb, transfers),
         report = COALESCE($6::jsonb, report),
         error = COALESCE($7, error),
         steps = CASE WHEN $8::jsonb IS NULL THEN steps ELSE steps || jsonb_build_array($8::jsonb) END,
         finished_at = CASE WHEN $9::boolean THEN now() ELSE finished_at END
       WHERE id = $1`,
      [id, patch.state ?? null, patch.toRevision ?? null,
        patch.createdPrices ? JSON.stringify(patch.createdPrices) : null,
        patch.transfers ? JSON.stringify(patch.transfers) : null,
        patch.report ? JSON.stringify(patch.report) : null,
        patch.error ?? null,
        patch.step ? JSON.stringify({ at: new Date().toISOString(), ...patch.step }) : null,
        Boolean(patch.finished)],
    );
  },
  async getRun(id) {
    const [r] = await q(`SELECT * FROM stripe_catalog_runs WHERE id = $1`, [id]);
    return r ? mapRun(r) : null;
  },
  async listRuns(context, limit) {
    const rows = await q(`SELECT * FROM stripe_catalog_runs WHERE catalog_context = $1 ORDER BY started_at DESC, id DESC LIMIT $2`, [context, limit]);
    return rows.map(mapRun);
  },
};

/** Version du code en service (journal, EX-002). */
export function codeVersion(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SOURCE_VERSION || env.CONTAINER_VERSION || env.APP_VERSION || 'dev').slice(0, 40);
}

/** Registre → prix résolu (pour une photographie amorcée depuis le registre). */
export function versionToResolved(v: PriceVersionRow, verifiedAt: string): ResolvedPrice {
  return {
    planCode: v.planCode,
    billingPeriod: v.billingPeriod,
    lookupKey: v.logicalLookupKey,
    priceId: v.stripePriceId,
    productId: v.stripeProductId,
    unitAmountCents: v.unitAmountCents,
    currency: 'eur',
    interval: v.interval,
    intervalCount: 1,
    taxBehavior: v.taxBehavior as ResolvedPrice['taxBehavior'],
    livemode: Boolean(v.livemode),
    priceRevision: v.priceRevision,
    verifiedAt,
  };
}
