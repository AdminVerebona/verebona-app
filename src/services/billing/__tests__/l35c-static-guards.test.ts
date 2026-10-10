/**
 * Garde-fous statiques du lot 35C (CDC « Migration Stripe vers lookup_key »
 * V4) : recherche de fin de chantier (§21.2), source unique des montants,
 * fraîcheur (PWA), migrations additives, tâches planifiées, mentions
 * d'économie inchangées, desktop/mobile (même composant).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|e2e)\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}
const SOURCES = walk('src');

describe('§21.2 — recherche de fin de chantier (code exécuté, hors tests et migrations)', () => {
  it.each([
    'resolvePriceId', 'resolvePlanFromPriceId', 'getTierFromPriceId', 'isValidPriceId', 'expectedAmountCents', 'PRICE_CATALOG', 'STRIPE_PRODUCTS',
  ])('aucune occurrence de %s', (needle) => {
    const hits = SOURCES.filter((f) => new RegExp(`\\b${needle}\\b`).test(read(f).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')));
    expect(hits).toEqual([]);
  });

  it('LK-89 / TC-73 — STRIPE_PRICE_* lues seulement par la double lecture de transition (et le diagnostic)', () => {
    const hits = SOURCES.filter((f) => /process\.env\.STRIPE_PRICE_|env\[['"]STRIPE_PRICE_|'STRIPE_PRICE_[A-Z_]+'/.test(read(f)));
    expect(hits).toEqual(['src/services/billing/legacy-price-env.ts']);
  });

  it('EC-04 / LK-31 — la page Offres ne contient plus de grille monétaire et transmet la révision affichée', () => {
    const page = read('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect(page).not.toMatch(/monthlyPrice|yearlyPrice|['"]\d+,\d{2} €['"]|['"]\d+ €['"]/);
    expect(page).toContain('useBillingCatalog');
    expect(page.match(/displayed_price_revision/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('<PriceChangedDialog');
  });

  it('LK-104 — le manifeste (candidat) n’est importé par aucun composant client', () => {
    const clients = SOURCES.filter((f) => /^['"]use client['"]/m.test(read(f)));
    for (const f of clients) {
      const src = read(f);
      expect(src, f).not.toMatch(/from ['"]@\/services\/billing\/(pricing-manifest|price-catalog\.service|catalog-store)['"]/);
      expect(src, f).not.toMatch(/from ['"]@\/db['"]/);
    }
  });

  it('LK-39 / LK-41 — Checkout : prix résolu, quantité 1, jamais de price_data ni d’essai Stripe', () => {
    const src = read('src/app/api/billing/create-checkout-session/route.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).toContain('line_items: [{ price: resolved.priceId, quantity: 1 }]');
    expect(src).not.toMatch(/price_data|trial_period_days|trial_end|subscriptions\.update/);
    expect(src).toContain('assertDisplayedRevision(resolved, displayedRevision)');
  });

  it('LK-46 — un seul parcours de montée en gamme : routes historiques retirées (410)', () => {
    for (const r of ['upgrade-apply', 'upgrade-preview']) {
      const src = read(`src/app/api/billing/${r}/route.ts`).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src).toContain('UPGRADE_FLOW_MOVED');
      expect(src).not.toMatch(/subscriptions\.update|priceId/);
    }
  });

  it('LK-69 / LK-70 — webhook : événements de catalogue, prise en charge atomique, contrôle du mode', () => {
    const src = read('src/app/api/billing/stripe-webhook/route.ts');
    expect(src).toContain('claimWebhookEvent(event');
    expect(src).toContain('handleCatalogEvent(event)');
    expect(src).toContain("claimInvoiceEffect(invoice.id, 'payment_succeeded')");
    expect(src).not.toMatch(/db\.delete\(stripeWebhookLogs\)/);
    expect(src).toMatch(/event\.livemode !== \(keyMode === 'live'\)/);
  });
});

describe('fraîcheur et caches (LK-22, LK-33)', () => {
  it('TC-61 — PWA : les routes /api/ sont servies en réseau seul (catalogue jamais figé par le service worker)', () => {
    const sw = read('public/sw.js');
    expect(sw).toMatch(/const isApiRoute = url\.pathname\.startsWith\('\/api\/'\)/);
    expect(sw).toMatch(/if \(isHtml \|\| isNextChunk \|\| isApiRoute\)/);
  });

  it('TC-14 — catalogue public : dynamique, cache HTTP borné, CORS limité à la vitrine, sans cookie', () => {
    const src = read('src/app/api/billing/catalog/route.ts');
    expect(src).toContain("export const dynamic = 'force-dynamic'");
    expect(src).toContain('NEXT_PUBLIC_PUBLIC_SITE_URL');
    expect(src).not.toMatch(/getSession|stripe\.|priceId/);
    expect(read('src/middleware.ts')).toContain("'/api/billing/catalog'");
  });
});

describe('migrations 0306-0308 (LK-84) et tâches planifiées (LK-102)', () => {
  it('additives, idempotentes, sans appel Stripe ni suppression de colonne', () => {
    const files = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => /^030[678]_/.test(f));
    expect(files.sort()).toEqual([
      '0306_stripe_lookup_key_catalog.sql', '0306_stripe_lookup_key_catalog_idx_1.sql',
      '0307_subscription_confirmation_amount.sql', '0308_price_change_notice_email_template.sql',
    ]);
    for (const f of files) {
      const sql = read(`src/db/migrations/${f}`).replace(/--.*$/gm, '');
      expect(sql, f).not.toMatch(/DROP\s+(COLUMN|TABLE)|stripe\.com/i);
      expect(sql.match(/CREATE (UNIQUE )?INDEX(?! CONCURRENTLY)(?! IF NOT EXISTS)/g) ?? [], f).toEqual([]);
    }
    expect(read('src/db/migrations/0306_stripe_lookup_key_catalog_idx_1.sql')).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
  });

  it('les migrations historiques 0066 / 0072 / 0180 ne sont pas réécrites (montants historiques conservés)', () => {
    expect(read('src/db/migrations/0072_pricing_v2_trial.sql')).toMatch(/plan_limits/);
  });

  it('tâches internes : synchronisation, publication (jamais au démarrage), revalorisation', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const byCode = new Map(SCHEDULED_TASKS.map((t) => [t.code, t]));
    expect(byCode.get('stripe-catalog-sync')?.schedule).toMatchObject({ kind: 'interval' });
    expect(byCode.get('stripe-catalog-publish')?.schedule).toMatchObject({ kind: 'interval' });
    expect(byCode.get('stripe-catalog-publish')?.schedule.kind).not.toBe('startup');
    expect(byCode.get('stripe-price-revaluation')?.schedule).toMatchObject({ kind: 'interval' });
  });
});

describe('mentions d’économie annuelle — hors périmètre, inchangées (LK-115, TC-89, RX-19)', () => {
  it('page Offres : mention « 2 mois » strictement inchangée', () => {
    expect(read('src/app/(dashboard)/mon-compte/offres/page.tsx')).toContain('En annuel, vous economisez l&apos;equivalent de 2 mois.');
  });
});

describe('desktop et mobile : composants uniques, responsives', () => {
  it('confirmation de tarif et prix contractuel : mêmes composants pour toutes les largeurs', () => {
    const dialog = read('src/components/billing/PriceChangedDialog.tsx');
    expect(dialog).toContain('AlertDialog');
    const summary = read('src/components/subscription/SubscriptionSummary.tsx');
    expect(summary).toContain('data-testid="tarif-contractuel"');
    expect(summary).toMatch(/grid gap-4 sm:grid-cols-2" data-testid="tarif-contractuel"/);
  });
});
