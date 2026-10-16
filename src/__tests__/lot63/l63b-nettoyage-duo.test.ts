/**
 * Lot 63B — décisions PO du 16/10.
 *
 *  L63-NET  Nettoyage : route `/api/documents/title-coherence` et son service
 *           supprimés (interdits de retour) ; Centre d'aide intégré
 *           `(dashboard)/aide` supprimé, `/aide…` redirigé vers le Centre
 *           d'aide public ; aucun lien interne n'y navigue plus ; restes du
 *           mode intégré retirés.
 *  L63-DUO  Rétractation d'un Premium Duo : gardes des chemins webhook
 *           (abonnement supprimé, activation Duo) — comportement prouvé sur
 *           PostgreSQL par `l63b-duo-retractation.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { publicSiteUrl } from '@/lib/external-urls';

const root = process.cwd();
const lire = (f: string) => readFileSync(join(root, f), 'utf8');

/** Fichiers source applicatifs (hors tests). */
function sources(dir = 'src', out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(root, rel)).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules' || rel === 'src/test') continue;
      sources(rel, out);
    } else if (/\.(ts|tsx)$/.test(e) && !/\.(test|e2e)\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}

describe('L63-NET — nettoyage', () => {
  it('L63-NET-01 — route title-coherence et son service supprimés, plus aucune référence, retour interdit', () => {
    expect(existsSync(join(root, 'src/app/api/documents/title-coherence'))).toBe(false);
    expect(existsSync(join(root, 'src/services/document-ai/title-coherence.service.ts'))).toBe(false);
    const refs = sources().filter((f) => /title-coherence|titleCoherence|applyTitleCoherenceSuggestions/.test(lire(f)));
    expect(refs).toEqual([]);
    const legacy = lire('scripts/check-legacy-ai.mjs');
    expect(legacy).toContain("path: 'src/app/api/documents/title-coherence/route.ts'");
    expect(legacy).toContain("path: 'src/services/document-ai/title-coherence.service.ts'");
  });

  it('L63-NET-02 — /aide redirige vers la page publique correspondante (anciens liens, favoris, e-mails, assistant)', async () => {
    expect(existsSync(join(root, 'src/app/(dashboard)/aide'))).toBe(false);
    const { GET, HEAD } = await import('@/app/aide/[[...slug]]/route');
    const cas: Array<[string, string]> = [
      ['/aide', '/aide'],
      ['/aide?page=%2Faide%2Fcreer-un-bien&retour=%2Fassets', '/aide/creer-un-bien'],
      ['/aide/creer-un-bien', '/aide/creer-un-bien'],
      ['/aide/theme/documents', '/aide/theme/documents'],
      ['/aide?q=agenda', '/aide?q=agenda'],
      ['/aide?page=%2Fcontact', '/contact'],
      // Jamais une adresse arbitraire.
      ['/aide?page=javascript:alert(1)', '/aide'],
      ['/aide?page=https%3A%2F%2Fevil.example', '/aide'],
      ['/aide?page=%2F%2Fevil.example%2Faide', '/aide'],
    ];
    for (const [entree, attendu] of cas) {
      const res = GET(new NextRequest(`https://app.verebona.test${entree}`));
      expect(res.status, entree).toBe(307);
      expect(res.headers.get('location'), entree).toBe(publicSiteUrl(attendu));
    }
    expect(HEAD).toBe(GET);
    // Accessible sans session (lien public) : hors du périmètre du middleware.
    expect(lire('src/middleware.ts')).not.toMatch(/'\/aide/);
  });

  it('L63-NET-03 — aucune navigation interne vers /aide (liens, router, notifications, e-mails)', () => {
    const fautifs: string[] = [];
    for (const f of sources()) {
      const src = lire(f);
      // Navigation dans l'application vers /aide (au lieu du site public / nouvel onglet).
      if (/router\.(push|replace)\(\s*['"`]\/aide/.test(src)) fautifs.push(`${f}: router → /aide`);
      if (/href=["']\/aide/.test(src)) fautifs.push(`${f}: href="/aide"`);
      if (/redirect\(\s*['"`]\/aide/.test(src)) fautifs.push(`${f}: redirect → /aide`);
      // Lien absolu vers l'application (e-mails, notifications, liens profonds).
      if (/(APP_URL|appBaseUrl\(\)|baseUrl)\}?\/aide/.test(src)) fautifs.push(`${f}: lien absolu app → /aide`);
      if (/deep_?[lL]ink[^\n]{0,40}['"`]\/aide/.test(src)) fautifs.push(`${f}: lien profond → /aide`);
    }
    expect(fautifs).toEqual([]);
    // Pieds de page : `/aide` part vers le site public (external).
    expect(lire('src/components/Footer.tsx')).toContain("{ href: '/aide',                      label: \"Centre d'aide\", external: true }");
    expect(lire('src/components/LandingFooter.tsx')).toContain("{ href: '/aide',    label: \"Centre d'aide\", external: true }");
  });

  it('L63-NET-05 — restes du Centre d’aide intégré retirés (mode intégré, retour, préférence mobile, cadre CSP)', () => {
    const open = lire('src/lib/help-center/open.ts');
    expect(open).not.toMatch(/EMBED_QUERY|integre=app|prefersIntegratedHelp|safeReturnPath/);
    expect(open).toContain("window.open(helpPageUrl(path), '_blank', 'noopener,noreferrer')");
    const conf = lire('next.config.mjs');
    expect(conf).toContain(`"frame-src 'self' https://js.stripe.com https://hooks.stripe.com"`);
    expect(conf).toContain("`connect-src 'self' https://api.stripe.com ${PUBLIC_SITE_ORIGIN}`");
  });
});

describe('L63-DUO — gardes des chemins webhook (rétractation)', () => {
  const webhook = lire('src/app/api/billing/stripe-webhook/route.ts');

  it('L63-DUO-07 — abonnement Duo supprimé sur un compte rétracté : sortie de Duo, ni EXPIRED ni e-mail « passage à Standard »', () => {
    const bloc = webhook.slice(webhook.indexOf('async function handleSubscriptionDeleted'), webhook.indexOf('// ── Premium sub ──'));
    expect(bloc).toContain('const withdrawnAccountId = await withdrawnAccountOfDuo(duoAccount.id, duoAccount.billingOwnerUserId);');
    // La garde précède la rétrogradation (qui écrit EXPIRED et envoie l'e-mail).
    expect(bloc.indexOf('await closeDuoForWithdrawal(withdrawnAccountId);')).toBeGreaterThan(-1);
    expect(bloc.indexOf('await closeDuoForWithdrawal(withdrawnAccountId);')).toBeLessThan(bloc.indexOf('await downgradeDuoAccount(duoAccount.id);'));
  });

  it('L63-DUO-08 — activation Duo (Checkout / passage à Duo) : jamais sur un compte rétracté', () => {
    const bloc = webhook.slice(webhook.indexOf('async function activateDuoOnAccount'));
    expect(bloc).toContain("if (account?.subscriptionStatus === 'WITHDRAWN') return;");
    expect(bloc.indexOf("if (account?.subscriptionStatus === 'WITHDRAWN') return;")).toBeLessThan(bloc.indexOf("planType: 'PREMIUM_DUO'"));
  });

  it('L63-DUO-09 — synchronisation : abonnement rétracté → Duo CANCELED, sortie de Duo existante réutilisée', () => {
    const sync = lire('src/services/billing/subscription-sync.service.ts');
    expect(sync).toContain("(withdrawn ? 'CANCELED' : isPaid ? (status === 'past_due' ? 'UNPAID_RECOVERY' : 'ACTIVE') : 'CANCELED')");
    expect(sync).toContain('await closeDuoForWithdrawal(account.id)');
    const service = lire('src/services/duo/duo-withdrawal.service.ts');
    expect(service).toContain('await endDuoSharing(ownerUserId);');
    expect(service).toContain("inArray(duoAccounts.subscriptionStatus, IN_OFFER)");
    const processor = lire('src/services/withdrawal/withdrawal-processor.service.ts');
    // Coupure locale (avant Stripe) et suppression du compte (avant la cascade).
    expect(processor.match(/await closeDuoForWithdrawal\(/g)).toHaveLength(2);
    expect(lire('src/lib/plan-enforcement.ts')).toContain('if (isWithdrawnStatus(newSubStatus)) await endDuoSharing(ownerUserId);');
  });
});
