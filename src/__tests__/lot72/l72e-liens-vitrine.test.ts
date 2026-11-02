/**
 * Lot 72 (72E) — liens entre l'application et la vitrine (ticket P2
 * « Nettoyage des liens obsolètes et sécurisation de la navigation »).
 *
 * Les destinations ne sont PAS codées en dur ici : elles viennent de
 * `src/lib/public-site/link-inventory.json`, copie de l'inventaire généré
 * par la vitrine depuis son code (routeur, sections de l'accueil, corpus,
 * anciennes URL). Voir `src/lib/public-site/link-inventory.ts`.
 *
 *   L72E-LV-01  pied de page public : « Pourquoi Verebona ? » retiré,
 *               « Comment ça marche ? » → /#how, « Tarifs » → /#pricing ;
 *   L72E-LV-02  audit transversal : chaque lien de l'application vers la
 *               vitrine (publicSiteUrl, entrées `external: true`, URL
 *               absolues) mène à une route, une page ou une ancre existante ;
 *               les appels non littéraux sont recensés ;
 *   L72E-LV-03  sens vitrine → application : chaque `appUrl('…')` de la
 *               vitrine désigne une route servie par l'application ;
 *   L72E-LV-04  copie de l'inventaire : schéma, et identité avec la vitrine
 *               si `VEREBONA_PUBLIC_REPO` désigne un clone.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { checkPublicHref, PUBLIC_LINK_INVENTORY: inv, LINK_INVENTORY_SCHEMA } = await import('@/lib/public-site/link-inventory');
const { publicSiteUrl } = await import('@/lib/external-urls');
const { HELP_CONTACT_PATH } = await import('@/lib/help-center/open');
const { LEGAL_PUBLIC_PATHS, LEGAL_LEGACY_PATHS } = await import('@/lib/legal/public-legal');

/**
 * Lot 102B : chemins de la rubrique « Légal » fixés par le CONTRAT avec le
 * site public (docs/exploitation/contrat-site-public-legal.md). Ils ne sont
 * pas encore dans l'inventaire généré par la vitrine tant qu'elle ne les a pas
 * livrés : ils sont contrôlés contre le contrat (L72E-LV-05), puis contre
 * l'inventaire dès qu'il les contient.
 */
const LEGAL_CONTRACT_PATHS = new Set(Object.values(LEGAL_PUBLIC_PATHS));
// Lot 104 : la vitrine a livré la rubrique « Légal » ; les adresses ACTUELLES du repli
// (/cgu, /mentions-legales, /confidentialite) y sont redirigées en 301 vers /legal/… :
// une redirection vers un chemin du contrat est une destination valide (aucun 404).
const legalPathVerdict = (path: string) => {
  const v = checkPublicHref(path) as { status: string; target?: string };
  if (LEGAL_CONTRACT_PATHS.has(path) && v.status === 'missing-page') return { status: 'ok' };
  if (v.status === 'redirect' && v.target && LEGAL_CONTRACT_PATHS.has(v.target)) return { status: 'ok' };
  return v;
};

const ROOT = process.cwd();
const lire = (f: string) => readFileSync(join(ROOT, f), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || rel === join('src', 'test')) continue;
      walk(rel, out);
    } else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.(test|e2e)\.tsx?$/.test(name)) {
      out.push(rel.split(sep).join('/'));
    }
  }
  return out;
}
const SOURCES = walk('src');

describe('L72E-LV-01 — pied de page public (LandingFooter)', () => {
  const src = lire('src/components/LandingFooter.tsx');

  it('L72E-LV-01a — « Pourquoi Verebona ? » a disparu (source et rendu)', () => {
    expect(src).not.toMatch(/Pourquoi Verebona/);
    expect(src).not.toContain('/pourquoi-verebona');
  });

  it('L72E-LV-01b — « Comment ça marche ? » → /#how via publicSiteUrl ; « Tarifs » → /#pricing', async () => {
    expect(src).toMatch(/\{ href: '\/#how',\s+label: 'Comment ça marche \?', external: true \}/);
    expect(src).toMatch(/\{ href: '\/#pricing',\s+label: 'Tarifs', external: true \}/);
    expect(src).not.toContain('/comment-ca-marche');
    const { LandingFooter } = await import('@/components/LandingFooter');
    const html = renderToStaticMarkup(h(LandingFooter));
    expect(html).toContain(`href="${publicSiteUrl('/#how')}"`);
    expect(html).toContain(`href="${publicSiteUrl('/#pricing')}"`);
    expect(html).toContain('Comment ça marche ?');
    expect(html).not.toContain('Pourquoi Verebona');
    // Toujours à l'environnement : jamais une adresse de vitrine écrite en dur.
    expect(src).not.toMatch(/https?:\/\/(www\.)?verebona\.fr/);
  });

  it('L72E-LV-01c — rendu : chaque lien du pied de page mène à une destination existante (vitrine) ou à une page de l’application', async () => {
    const { LandingFooter, AuthFooter } = await import('@/components/LandingFooter');
    const { Footer } = await import('@/components/Footer');
    const base = publicSiteUrl('/').replace(/\/$/, '');
    for (const html of [renderToStaticMarkup(h(LandingFooter)), renderToStaticMarkup(h(AuthFooter)), renderToStaticMarkup(h(Footer))]) {
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      expect(hrefs.length).toBeGreaterThan(1);
      for (const href of hrefs) {
        if (href.startsWith(base)) {
          const chemin = href.slice(base.length) || '/';
          expect({ href, verdict: legalPathVerdict(chemin) }).toEqual({ href, verdict: { status: 'ok' } });
        } else {
          // Lien servi par l'application (rétractation) ; lot 102B : plus les CGUV.
          expect(['/retractation']).toContain(href);
        }
      }
    }
  });
});

/** Liens de l'application vers la vitrine, extraits des sources. */
const liens: Array<{ file: string; path: string; via: string }> = [];
const nonLitteraux: string[] = [];
for (const file of SOURCES) {
  const src = lire(file);
  for (const m of src.matchAll(/\bpublicSiteUrl\(\s*(['"`])([^'"`]*)\1\s*\)/g)) liens.push({ file, path: m[2], via: 'publicSiteUrl' });
  for (const m of src.matchAll(/\bpublicSiteUrl\((?!\s*['"`)])/g)) {
    if (!/export function publicSiteUrl\(/.test(src.slice(Math.max(0, (m.index ?? 0) - 16), (m.index ?? 0) + 15))) nonLitteraux.push(file);
  }
  for (const m of src.matchAll(/\{\s*href:\s*'([^']+)'[^}]*\bexternal:\s*true[^}]*\}/g)) liens.push({ file, path: m[1], via: 'external: true' });
  // Lot 102B : liens légaux par CONTENU (`legalKey: 'cguv'`, `legal.cguv` /
  // `legalLinks.cguv` de `useLegalLinks`) — chacun vise l'adresse ACTUELLE du
  // site (repli) puis la NOUVELLE (/legal/…) : les deux sont contrôlées.
  const legalKeys = [
    ...[...src.matchAll(/\blegalKey:\s*'(\w+)'/g)].map((m) => m[1]),
    ...(src.includes('useLegalLinks()') ? [...src.matchAll(/\blegal(?:Links)?\.(mentionsLegales|cguv|confidentialite|sousTraitants|parrainage)\b/g)].map((m) => m[1]) : []),
  ];
  for (const k of legalKeys) {
    liens.push({ file, path: (LEGAL_LEGACY_PATHS as Record<string, string>)[k] ?? `?${k}`, via: 'legal-repli' });
    liens.push({ file, path: (LEGAL_PUBLIC_PATHS as Record<string, string>)[k] ?? `?${k}`, via: 'legal-v2' });
  }
  for (const m of src.matchAll(/https?:\/\/(?:www\.|preprod\.)?verebona\.fr(\/[^\s'"`)<>\]]*)/g)) liens.push({ file, path: m[1], via: 'URL absolue' });
}

describe('L72E-LV-02 — audit transversal app → vitrine (headers, footers, auth, aide, e-mails, compte)', () => {
  it('L72E-LV-02a — l’extraction n’est pas vide (pieds de page, authentification, rétractation, compte)', () => {
    const fichiers = new Set(liens.map((l) => l.file));
    for (const f of [
      'src/components/LandingFooter.tsx', 'src/components/Footer.tsx', 'src/app/(auth)/login/page.tsx',
      'src/app/(auth)/verify-email/page.tsx', 'src/app/retractation/page.tsx', 'src/components/account/LegalInformationCard.tsx',
    ]) expect(fichiers, f).toContain(f);
    expect(liens.length).toBeGreaterThan(20);
  });

  it('L72E-LV-02b — aucune ancienne URL, aucune page retirée, aucun lien cassé, aucune ancre absente', () => {
    const anomalies = liens
      .map((l) => ({ ...l, verdict: legalPathVerdict(l.path) }))
      .filter((l) => l.verdict.status !== 'ok');
    expect(anomalies).toEqual([]);
  });

  it('L72E-LV-02c — appels non littéraux de publicSiteUrl : recensés (cible validée par ailleurs)', () => {
    // · pieds de page : `resolveHref(link)` — les `href` sont contrôlés en 02b ;
    // · Centre d'aide : `helpPageUrl` n'accepte que `/aide…` ou `/contact`
    //   (`isHelpPath`), et les articles viennent du catalogue publié de
    //   l'environnement (contrôle `check-help-shortcuts`).
    // · lot 102B : `lib/legal/public-legal` — chemins du contrat (L72E-LV-05).
    // · lot 102C : `privacyPolicyUrl(env)` — chemin `/confidentialite` ou réglé
    //   par l'exploitation (appel sans argument = configuration 102B ci-dessus).
    expect([...new Set(nonLitteraux)].sort()).toEqual([
      'src/components/Footer.tsx', 'src/components/LandingFooter.tsx', 'src/lib/help-center/open.ts', 'src/lib/legal/public-legal.ts',
      'src/services/trial-lifecycle/signup-collection.ts',
    ]);
    expect(checkPublicHref('/aide')).toEqual({ status: 'ok' });
    expect(checkPublicHref(HELP_CONTACT_PATH)).toEqual({ status: 'ok' });
  });

  it('L72E-LV-02d — e-mails transactionnels : aucun lien vers la vitrine écrit en dur hors publicSiteUrl', () => {
    const mails = SOURCES.filter((f) => f.startsWith('src/lib/email/') || f.startsWith('src/services/email/'));
    expect(mails.length).toBeGreaterThan(0);
    for (const f of mails) expect(lire(f), f).not.toMatch(/https?:\/\/(www\.|preprod\.)?verebona\.fr\/[a-z]/);
  });

  it('L72E-LV-02e — le contrôle détecte bien les régressions (anciennes routes, ancre inconnue, route dynamique)', () => {
    expect(checkPublicHref('/comment-ca-marche')).toEqual({ status: 'redirect', target: '/#how' });
    expect(checkPublicHref('/pourquoi-verebona')).toEqual({ status: 'retired' });
    expect(checkPublicHref('/#comment-ca-marche')).toEqual({ status: 'missing-anchor', anchor: 'comment-ca-marche' });
    expect(checkPublicHref('/legal')).toEqual({ status: 'redirect', target: '/legal/mentions-legales' });
    expect(checkPublicHref('/legal/inexistant')).toEqual({ status: 'missing-page' });
    expect(checkPublicHref('/aide/article-qui-n-existe-pas')).toEqual({ status: 'missing-page' });
    expect(checkPublicHref(inv.pages.help[0])).toEqual({ status: 'ok' });
  });
});

/** Route de l'application servant `p` (groupes `(x)` et segments dynamiques compris). */
function appRouteExists(p: string): boolean {
  const segments = p.split('?')[0].split('/').filter(Boolean);
  const isApi = segments[0] === 'api';
  const resolve = (dir: string, rest: string[]): boolean => {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return false;
    const entries = readdirSync(abs);
    if (rest.length === 0) {
      if (entries.includes(isApi ? 'route.ts' : 'page.tsx') || entries.includes('route.ts')) return true;
      if (entries.some((e) => /^\[\[\.\.\.[^\]]+\]\]$/.test(e) && resolve(join(dir, e), []))) return true;
    }
    for (const e of entries) {
      if (!statSync(join(abs, e)).isDirectory()) continue;
      if (/^\(.+\)$/.test(e) && resolve(join(dir, e), rest)) return true;
      if (rest.length === 0) continue;
      if (e === rest[0] && resolve(join(dir, e), rest.slice(1))) return true;
      if (/^\[[^.\]][^\]]*\]$/.test(e) && resolve(join(dir, e), rest.slice(1))) return true;
      if (/^\[{1,2}\.\.\.[^\]]+\]{1,2}$/.test(e) && resolve(join(dir, e), [])) return true;
    }
    return false;
  };
  return resolve('src/app', segments);
}

describe('L72E-LV-03 — sens vitrine → application', () => {
  it('L72E-LV-03a — chaque route de l’application appelée par la vitrine existe (connexion, inscription, accueil, API)', () => {
    expect(inv.appLinks).toEqual(expect.arrayContaining(['/login', '/signup']));
    const absentes = inv.appLinks.filter((p) => !appRouteExists(p));
    expect(absentes).toEqual([]);
  });

  it('L72E-LV-03b — le résolveur n’est pas complaisant', () => {
    expect(appRouteExists('/pourquoi-verebona')).toBe(false);
    expect(appRouteExists('/api/nexiste-pas')).toBe(false);
    expect(appRouteExists('/cgvu')).toBe(true);
    expect(relative(ROOT, join(ROOT, 'src/app'))).toBe(join('src', 'app'));
  });
});

describe('L72E-LV-05 — lot 102B : rubrique « Légal » du site public (contrat)', () => {
  it('L72E-LV-05a — cinq contenus, une URL directe et stable chacun, sous /legal/', () => {
    expect(Object.keys(LEGAL_PUBLIC_PATHS).sort()).toEqual(['cguv', 'confidentialite', 'mentionsLegales', 'parrainage', 'sousTraitants']);
    for (const p of LEGAL_CONTRACT_PATHS) expect(p).toMatch(/^\/legal\/[a-z-]+$/);
    expect(new Set(LEGAL_CONTRACT_PATHS).size).toBe(5);
  });

  it('L72E-LV-05b — les chemins sont ceux du contrat documenté pour l’équipe du site public', () => {
    const contrat = lire('docs/exploitation/contrat-site-public-legal.md');
    for (const p of LEGAL_CONTRACT_PATHS) expect(contrat, p).toContain(p);
    expect(contrat).toContain('/legal/cguv/versions.json');
  });

  it('L72E-LV-05c — chaque lien légal de l’application vise un contenu connu : chemin du contrat (v2) et adresse actuelle (repli)', () => {
    const v2 = liens.filter((l) => l.via === 'legal-v2');
    expect(v2.length).toBeGreaterThan(8);
    for (const l of v2) expect(LEGAL_CONTRACT_PATHS.has(l.path), `${l.file} → ${l.path}`).toBe(true);
  });

  it('L72E-LV-05d — repli : chaque adresse ACTUELLE existe sur la vitrine (inventaire) — aucun 404 avant la livraison du site', () => {
    for (const p of Object.values(LEGAL_LEGACY_PATHS)) expect({ p, v: legalPathVerdict(p) }).toEqual({ p, v: { status: 'ok' } });
    expect(liens.filter((l) => l.via === 'legal-repli').length).toBeGreaterThan(8);
  });
});

describe('L72E-LV-04 — copie de l’inventaire de la vitrine', () => {
  it('L72E-LV-04a — schéma attendu, généré (pas une liste saisie : routes, ancres, pages, anciennes URL)', () => {
    expect(inv.schema).toBe(LINK_INVENTORY_SCHEMA);
    expect(inv.routes.static).toContain('/');
    expect(inv.homeAnchors).toEqual(expect.arrayContaining(['how', 'pricing', 'faq']));
    expect(inv.legacyRedirects['/comment-ca-marche']).toBe('/#how');
    expect(inv.retired).toContain('/pourquoi-verebona');
    expect(inv.pages.help.length).toBeGreaterThan(10);
  });

  const repo = process.env.VEREBONA_PUBLIC_REPO;
  it.skipIf(!repo)('L72E-LV-04b — identique à l’inventaire commité de la vitrine (VEREBONA_PUBLIC_REPO)', () => {
    const vitrine = readFileSync(join(repo!, 'link-inventory.json'), 'utf8');
    expect(lire('src/lib/public-site/link-inventory.json')).toBe(vitrine);
  });
});
