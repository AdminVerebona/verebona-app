/**
 * Lot 108L — contrôle automatisé des liens juridiques (ticket « livraison
 * complète et vérifiable des informations légales », recette bloquante) :
 *
 *   · aucun lien juridique de l'application ni des e-mails ne pointe vers
 *     l'application (app.*, chemins `/cguv…`) ni vers `/cgvu` ;
 *   · la consultation d'une version passe par le site public de
 *     l'environnement (`NEXT_PUBLIC_PUBLIC_SITE_URL`), et SEULEMENT si son
 *     texte y est vérifié — sinon `null` (état explicite), jamais une autre
 *     version ;
 *   · la preuve (`versionProofInfo`) reste distincte et inchangée.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { buildLegalLinkPolicy, checkLegalUrl } from '@/lib/legal/open-legal-link';
import { LEGAL_PUBLIC_PATHS, resolveLegalLinks } from '@/lib/legal/public-legal';
import { cguvAcceptable } from '@/components/legal/CguvPublicTextNotice';
import { renderLegalErrorPage } from '@/services/legal/legal-error-page';
import {
  publicTextAvailability, versionConsultationUrl, versionProofInfo,
} from '@/services/legal/cguv-referential.service';

vi.mock('@/db', () => ({ db: {}, pgClient: {}, ensureMigrations: async () => undefined }));

const ROOT = resolve(__dirname, '../../../..');
const SITE = 'https://preprod.verebona.fr';
const APP = 'https://app.preprod.verebona.fr';
const SHA = 'a'.repeat(64);

/* ── 1. Code : aucun lien juridique vers l'application ni /cgvu ─────────── */

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = join(dir, f);
    if (f === '__tests__' || f === 'node_modules' || f === 'e2e' || f === 'test') continue;
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(f) && !/\.(test|e2e)\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

/** Code sans commentaires (les explications historiques citent les anciennes adresses). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/**
 * Fichiers qui SERVENT les anciennes adresses (redirections vers le site
 * public, archive technique de preuve) ou les déclarent publiques : ils
 * nomment ces chemins sans jamais en faire un lien.
 */
const LEGACY_HANDLERS = [
  /^src\/app\/cgvu\//, /^src\/app\/cguv\//, /^src\/app\/api\/legal\/cgvu\//, /^src\/app\/admin\/cgvu\//,
  /^src\/app\/api\/me\/legal\/cgvu-applicable\//, /^src\/middleware\.ts$/,
  // `versionProofInfo` (identifiant de PREUVE, jamais un lien) et liste des chemins historiques refusés.
  /^src\/services\/legal\/cguv-referential\.service\.ts$/, /^src\/lib\/legal\/open-legal-link\.ts$/,
];

describe('L108L-LINK-01 — aucun lien juridique vers app.* ni /cgvu dans l’application et les e-mails', () => {
  const files = walk('src').filter((p) => !LEGACY_HANDLERS.some((r) => r.test(p)));

  it('aucune chaîne « …/cgvu » (ancienne adresse) hors des gestionnaires de redirection', () => {
    const offenders = files.filter((p) => /['"`][^'"`\n]*\/cgvu(?![-\w])/.test(code(readFileSync(join(ROOT, p), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('aucune construction de lien `${base}/cguv…` sur l’application (seul /legal/cguv du site public)', () => {
    const offenders = files.filter((p) => {
      const c = code(readFileSync(join(ROOT, p), 'utf8'));
      return /\}\/cguv(?:\/|`|['"])/.test(c) || /['"`]\/cguv(?:\/versions)?['"`/]/.test(c.replace(/['"`]\/admin\/cguv['"`]/g, ''));
    });
    expect(offenders).toEqual([]);
  });

  it('aucun domaine app.*.verebona.fr en dur comme destination juridique', () => {
    const offenders = files.filter((p) => /https:\/\/app\.(?:[a-z0-9-]+\.)?verebona\.fr\/(?:cguv|cgvu|legal)/.test(code(readFileSync(join(ROOT, p), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('e-mails (gabarits, amorçages) : variable de lien légal, jamais une adresse de l’application', () => {
    for (const p of ['src/lib/email/email-html-templates.ts', 'src/db/seeds/legal/email_template_cgvu.ts', 'src/db/seeds/withdrawal/email_template_withdrawal.ts']) {
      const c = code(readFileSync(join(ROOT, p), 'utf8'));
      expect(c, p).not.toMatch(/\/cgvu|app\.[a-z.]*verebona|\/cguv\/versions/);
    }
    for (const p of ['src/services/withdrawal/receipt.service.ts', 'src/services/admin/communications.service.ts', 'src/services/legal/legal-subscription.hook.ts']) {
      const c = code(readFileSync(join(ROOT, p), 'utf8'));
      expect(c, p).not.toMatch(/legalPermalinkUrl:\s*`\$\{base\}|legalPermalinkUrl = `\$\{base\}|versionProofInfo\(/);
    }
  });

  it('page d’erreur des anciennes adresses : lien « version en vigueur » sur le site public, jamais /cguv relatif', () => {
    const withUrl = renderLegalErrorPage({ title: 't', message: 'm', offerCurrentLink: true, currentUrl: `${SITE}/legal/cguv` });
    expect(withUrl).toContain(`href="${SITE}/legal/cguv"`);
    expect(withUrl).not.toMatch(/href="\/cguv"/);
    const without = renderLegalErrorPage({ title: 't', message: 'm', offerCurrentLink: true });
    expect(without).not.toMatch(/href="\/cguv"|Consulter la version des CGUV/);
  });

  it('les 5 contenus en v2 : /legal/… du site public de l’environnement', () => {
    const links = resolveLegalLinks('v2', SITE);
    expect(links).toEqual({
      mentionsLegales: `${SITE}/legal/mentions-legales`, cguv: `${SITE}/legal/cguv`, confidentialite: `${SITE}/legal/confidentialite`,
      sousTraitants: `${SITE}/legal/sous-traitants`, parrainage: `${SITE}/legal/parrainage`,
    });
    for (const href of Object.values(links)) expect(new URL(href).origin).toBe(SITE);
    expect(Object.values(LEGAL_PUBLIC_PATHS).every((p) => p.startsWith('/legal/'))).toBe(true);
  });
});

/* ── 2. Liste blanche : l'application n'est jamais une cible ─────────────── */

describe('L108L-LINK-02 — ouverture (web et natif) : site public seulement', () => {
  const policy = buildLegalLinkPolicy({ publicSiteUrl: SITE, appOrigin: APP, production: true });
  it.each([
    `${APP}/cguv/versions/2026-07-30-v1`, `${APP}/cgvu`, `${APP}/cguv`, `${APP}/api/legal/cgvu/versions/2026-07-30-v1/download`, '/cguv/versions/2026-07-30-v1',
  ])('refusée : %s', (url) => {
    expect(checkLegalUrl(url, policy)).toEqual({ ok: false, reason: 'domain' });
  });
  it.each(['/legal/mentions-legales', '/legal/cguv', '/legal/confidentialite', '/legal/sous-traitants', '/legal/parrainage', '/legal/cguv/versions/2026-07-30-v1'])(
    'admise : site public %s', (p) => { expect(checkLegalUrl(`${SITE}${p}`, policy).ok).toBe(true); },
  );
});

/* ── 3. Consultation ≠ preuve ───────────────────────────────────────────── */

describe('L108L-LINK-03 — consultation publique vérifiée, preuve inchangée', () => {
  const legacy = { versionCode: '2026-07-30-v1', source: 'APP_LEGACY' as const, permalink: '/cgvu/versions/2026-07-30-v1', sha256: SHA, publicPermalink: null, publicSha256: null };

  it('archive APP_LEGACY non reprise par le site : AUCUN lien de consultation (état explicite), preuve d’origine conservée', () => {
    expect(publicTextAvailability(legacy)).toBe('NOT_ON_PUBLIC_SITE');
    expect(versionConsultationUrl(legacy, SITE)).toBeNull();
    // Preuve technique : inchangée (archive de l'application, jamais présentée comme lien).
    expect(versionProofInfo(legacy, APP)).toEqual({ permalinkUrl: `${APP}/cguv/versions/2026-07-30-v1`, sha256: SHA });
  });

  it('archive reprise avec l’empreinte d’ORIGINE : permalien public de cette version exacte', () => {
    const linked = { ...legacy, publicPermalink: `${SITE}/legal/cguv/versions/2026-07-30-v1`, publicSha256: SHA };
    expect(versionConsultationUrl(linked, SITE)).toBe(`${SITE}/legal/cguv/versions/2026-07-30-v1`);
    // Empreinte publique différente : jamais rattachée.
    expect(versionConsultationUrl({ ...linked, publicSha256: 'b'.repeat(64) }, SITE)).toBeNull();
  });

  it('version publiée par le site : /legal/cguv/versions/{code} sur la base de l’environnement (jamais une autre version)', () => {
    const pub = { versionCode: '2026-10-30-v1', source: 'PUBLIC_SITE' as const, permalink: 'https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1', sha256: SHA, publicPermalink: null, publicSha256: null };
    expect(versionConsultationUrl(pub, SITE)).toBe(`${SITE}/legal/cguv/versions/2026-10-30-v1`);
    expect(versionConsultationUrl(pub, `${SITE}/`)).toBe(`${SITE}/legal/cguv/versions/2026-10-30-v1`);
  });

  it('formulaires : une version non disponible sur le site public n’est pas acceptable (bouton désactivé, aucun lien)', () => {
    expect(cguvAcceptable({ publicText: 'NOT_ON_PUBLIC_SITE', permalinkUrl: null })).toBe(false);
    expect(cguvAcceptable({ publicText: 'VERIFIED', permalinkUrl: `${APP}/cguv/versions/x` })).toBe(true);
    expect(cguvAcceptable({ publicText: 'VERIFIED', permalinkUrl: null })).toBe(false);
    expect(cguvAcceptable(null)).toBe(true); // non chargée : le serveur tranche (refus 503 CGUV_PUBLIC_TEXT_UNAVAILABLE)
  });
});

describe('L108L-LINK-04 — Mon compte : « en vigueur » → /legal/cguv, « acceptée » → sa version exacte, preuve à part', () => {
  const card = code(readFileSync(join(ROOT, 'src/components/account/LegalInformationCard.tsx'), 'utf8'));
  it('version acceptée : lien de consultation publique, jamais la version courante en repli', () => {
    expect(card).toMatch(/href=\{latest\.consultationUrl\}/);
    expect(card).not.toMatch(/fallbackHref=\{legal\.cguv\}/);
    expect(card).not.toMatch(/href=\{(latest|a)\.permalinkUrl\}/);
    expect(card).toMatch(/data-testid="legal-accepted-proof"/);
  });
  it('version en vigueur : lien /legal/cguv résolu (useLegalLinks)', () => {
    expect(card).toMatch(/href=\{legal\.cguv\}[\s\S]{0,120}data-testid="legal-current-version"/);
  });
  it('aucun fichier ne présente l’URL de preuve comme lien utilisateur', () => {
    const rel = (p: string) => relative(ROOT, join(ROOT, p));
    const offenders = walk('src').filter((p) => /\.tsx$/.test(p)).filter((p) => /href=\{[^}]*proof[^}]*\}/.test(code(readFileSync(join(ROOT, p), 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });
});
