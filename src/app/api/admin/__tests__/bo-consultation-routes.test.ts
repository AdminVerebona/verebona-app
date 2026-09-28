/**
 * Routes BO de consultation — CDC Back-Office V1 §7 à §10, matrice §20.
 *
 * Abonnements, parrainages/promotions et référentiels sont en lecture seule ;
 * Communications n'expose qu'une mutation : l'activation d'un canal (PATCH),
 * et un envoi de test (POST) dont le destinataire vient de la session.
 * Chaque route appelle la garde administrateur serveur (GEN-002).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(process.cwd(), 'src', 'app', 'api', 'admin');
const ZONES = ['subscriptions', 'referrals', 'referentials', 'communications'];

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === 'route.ts' ? [full] : [];
  });
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const methods = (src: string) =>
  [...strip(src).matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);

const all = ZONES.flatMap((z) => routes(join(ROOT, z))).map((full) => ({
  full,
  rel: relative(ROOT, full).split(sep).join('/'),
  src: readFileSync(full, 'utf8'),
}));

/** Mutations admises (matrice §20). */
const ALLOWED_MUTATIONS: Record<string, string[]> = {
  'communications/channels/route.ts': ['PATCH'],
  'communications/test/route.ts': ['POST'],
};

describe('routes de consultation BO (§7 à §10)', () => {
  it('couvre les quatre zones', () => {
    for (const z of ZONES) expect(all.some((r) => r.rel.startsWith(`${z}/`)), z).toBe(true);
  });

  it.each(all.map((r) => [r.rel, r]))('%s : garde admin avant tout accès', (_rel, r) => {
    const src = strip((r as { src: string }).src);
    expect(src).toMatch(/\brequireAdmin\s*\(/);
  });

  it.each(all.map((r) => [r.rel, r]))('%s : aucune mutation hors matrice §20', (rel, r) => {
    const found = methods((r as { src: string }).src).filter((m) => m !== 'GET');
    expect(found).toEqual(ALLOWED_MUTATIONS[rel as string] ?? []);
  });

  it('test e-mail : destinataire lu dans la session, jamais dans le corps (COM-010)', () => {
    const src = strip(all.find((r) => r.rel === 'communications/test/route.ts')!.src);
    expect(src).toMatch(/session\.email/);
    expect(src).not.toMatch(/body\.(to|email|testEmail|recipient)/);
  });

  it('pas d’identifiant Stripe ni de facture exposés (SUB-012, SUB-013)', () => {
    for (const r of all.filter((x) => x.rel.startsWith('subscriptions/'))) {
      const src = strip(r.src);
      expect(src).not.toMatch(/hosted_invoice_url|invoice_pdf|hostedInvoiceUrl|invoicePdf/);
    }
  });
});
