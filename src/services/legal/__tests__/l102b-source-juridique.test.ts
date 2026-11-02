/**
 * Lot 102B — site public = source juridique unique, preuves d'acceptation,
 * réacceptation, démarrage immédiat (tests purs et statiques).
 *
 *   L102B-01  manifeste public : validation stricte, tout ou rien
 *   L102B-02  lecture du manifeste : panne, délai, JSON, empreinte du manifeste
 *   L102B-03  alerte Supervision : seuil d'échecs, dès le premier sans état connu
 *   L102B-04  preuve : permalien + empreinte selon l'origine de la version
 *   L102B-05  réacceptation : écritures métier refusées, issues toujours ouvertes
 *   L102B-06  liens publics, canal, terminologie CGUV
 *   L102B-07  plus aucun texte juridique servi ni maintenu par l'application
 *   L102B-08  demande de démarrage immédiat : stricte, libellé factuel
 *   L102B-09  migration additive, tâche planifiée, diagnostic
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  CGUV_MANIFEST_SCHEMA, allowedLegalOrigins, fetchCguvManifest, manifestUrl, parseCguvManifest, verifyTextSha256,
} from '../cguv-manifest';
import {
  CGUV_REACCEPTANCE_REQUIRED_CODE, isApiAllowedDuringReacceptance,
} from '@/lib/legal/reacceptance-gate';
import {
  LEGAL_PUBLIC_PATHS, channelFrom, cguvVersionPath, isCguvVersionCode,
} from '@/lib/legal/public-legal';
import {
  IMMEDIATE_START_FIELD, IMMEDIATE_START_HINT, IMMEDIATE_START_LABEL, isImmediateStartRequested,
} from '@/lib/legal/immediate-start';

vi.mock('@/db', () => ({ db: {}, pgClient: {}, ensureMigrations: async () => undefined }));

const ENV = { NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://www.verebona.fr' };
const SHA = 'a'.repeat(64);
const ROOT = process.cwd();
const lire = (f: string) => readFileSync(join(ROOT, f), 'utf8');

function manifest(over: Record<string, unknown> = {}, version: Record<string, unknown> = {}) {
  return {
    schema: CGUV_MANIFEST_SCHEMA,
    document: 'CGUV',
    generatedAt: '2026-11-15T09:00:00Z',
    current: '2026-11-15-v1',
    versions: [
      {
        code: '2026-11-15-v1',
        permalink: 'https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1',
        textUrl: 'https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1.html',
        sha256: SHA,
        publishedAt: '2026-11-15T09:00:00Z',
        requiresReacceptance: true,
        changeSummary: 'Résumé simple.',
        ...version,
      },
      {
        code: '2026-10-30-v1',
        permalink: 'https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1',
        sha256: 'b'.repeat(64),
        publishedAt: '2026-10-30T08:00:00Z',
        requiresReacceptance: false,
      },
    ],
    ...over,
  };
}

describe('L102B-01 — manifeste public : validation stricte, tout ou rien', () => {
  it('L102B-01a — manifeste conforme : versions, version courante, décision figée, effet par défaut = publication', () => {
    const r = parseCguvManifest(manifest(), ENV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.current).toBe('2026-11-15-v1');
    expect(r.manifest.versions).toHaveLength(2);
    const v = r.manifest.versions[0];
    expect(v).toMatchObject({ code: '2026-11-15-v1', sha256: SHA, requiresReacceptance: true, changeSummary: 'Résumé simple.' });
    expect(v.effectiveAt.toISOString()).toBe('2026-11-15T09:00:00.000Z');
  });

  it.each([
    ['schéma inconnu', manifest({ schema: 'autre' })],
    ['document autre', manifest({ document: 'CGU' })],
    ['version courante absente', manifest({ current: '2026-12-01-v1' })],
    ['code au mauvais format', manifest({}, { code: '2026-11-15' })],
    ['date impossible', manifest({ current: '2026-02-31-v1' }, { code: '2026-02-31-v1' })],
    ['empreinte invalide', manifest({}, { sha256: 'xyz' })],
    ['décision « substantielle » non booléenne', manifest({}, { requiresReacceptance: 'true' })],
    ['décision absente', manifest({}, { requiresReacceptance: undefined })],
    ['permalien hors du site public', manifest({}, { permalink: 'https://evil.example/legal/cguv/versions/2026-11-15-v1' })],
    ['permalien en HTTP', manifest({}, { permalink: 'http://www.verebona.fr/legal/cguv/versions/2026-11-15-v1' })],
    ['texte figé hors du site', manifest({}, { textUrl: 'https://cdn.example/x.html' })],
    ['date de publication absente', manifest({}, { publishedAt: 'hier' })],
    ['liste vide', manifest({ versions: [] })],
  ])('L102B-01b — refusé en entier : %s', (_label, raw) => {
    const r = parseCguvManifest(raw, ENV);
    expect(r.ok).toBe(false);
  });

  it('L102B-01c — code en double et permalien partagé : refusé', () => {
    const m = manifest();
    (m.versions as Array<Record<string, unknown>>)[1].code = '2026-11-15-v1';
    expect(parseCguvManifest(m, ENV).ok).toBe(false);
    const m2 = manifest();
    (m2.versions as Array<Record<string, unknown>>)[1].permalink = (m2.versions as Array<Record<string, unknown>>)[0].permalink;
    expect(parseCguvManifest(m2, ENV).ok).toBe(false);
  });

  it('L102B-01d — origine du site par environnement ; HTTP admis seulement en local ; origines supplémentaires explicites', () => {
    expect(allowedLegalOrigins({ NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr/' })).toEqual(['https://preprod.verebona.fr']);
    expect(allowedLegalOrigins({ ...ENV, LEGAL_PUBLIC_EXTRA_ORIGINS: 'https://verebona.fr' })).toEqual(['https://www.verebona.fr', 'https://verebona.fr']);
    const local = { NEXT_PUBLIC_PUBLIC_SITE_URL: 'http://localhost:4000' };
    const m = manifest({}, { permalink: 'http://localhost:4000/legal/cguv/versions/2026-11-15-v1', textUrl: undefined });
    (m.versions as Array<Record<string, unknown>>)[1].permalink = 'http://localhost:4000/legal/cguv/versions/2026-10-30-v1';
    expect(parseCguvManifest(m, local).ok).toBe(true);
  });

  it('L102B-01e — adresse du manifeste : base du site de l’environnement, surcharge LEGAL_CGUV_MANIFEST_URL', () => {
    expect(manifestUrl(ENV)).toBe('https://www.verebona.fr/legal/cguv/versions.json');
    expect(manifestUrl({ NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr' })).toBe('https://preprod.verebona.fr/legal/cguv/versions.json');
    expect(manifestUrl({ ...ENV, LEGAL_CGUV_MANIFEST_URL: 'https://x.test/m.json' })).toBe('https://x.test/m.json');
  });
});

describe('L102B-02 — lecture du manifeste (ne lève jamais)', () => {
  const res = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

  it('L102B-02a — succès : manifeste validé et empreinte du fichier lu', async () => {
    const body = JSON.stringify(manifest());
    const r = await fetchCguvManifest({ env: ENV, fetchImpl: async () => res(body) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('L102B-02b — HTTP 404 / 500 : indisponible ; réseau coupé : indisponible', async () => {
    expect(await fetchCguvManifest({ env: ENV, fetchImpl: async () => res('', 404) })).toMatchObject({ ok: false, kind: 'unavailable', error: 'HTTP 404' });
    expect(await fetchCguvManifest({ env: ENV, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('L102B-02c — délai dépassé : indisponible, sans attendre indéfiniment', async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const r = await fetchCguvManifest({ env: { ...ENV, LEGAL_MANIFEST_TIMEOUT_MS: '20' }, fetchImpl: hang });
    expect(r).toMatchObject({ ok: false, kind: 'unavailable' });
    if (!r.ok) expect(r.error).toMatch(/délai dépassé/);
  });

  it('L102B-02d — JSON illisible ou manifeste invalide : « invalide »', async () => {
    expect(await fetchCguvManifest({ env: ENV, fetchImpl: async () => res('<html>') })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await fetchCguvManifest({ env: ENV, fetchImpl: async () => res(JSON.stringify({ schema: 'x' })) })).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('L102B-02e — vérification du texte figé : octets exacts, réseau en panne = sans conclusion', async () => {
    const text = '<html>CGUV</html>';
    const sha = createHash('sha256').update(text).digest('hex');
    expect(await verifyTextSha256('https://www.verebona.fr/x.html', sha, { fetchImpl: async () => new Response(text) })).toBe(true);
    expect(await verifyTextSha256('https://www.verebona.fr/x.html', SHA, { fetchImpl: async () => new Response(text) })).toBe(false);
    expect(await verifyTextSha256('https://www.verebona.fr/x.html', sha, { fetchImpl: async () => { throw new Error('down'); } })).toBeNull();
  });
});

describe('L102B-03 — alerte Supervision', () => {
  it('L102B-03a — dès le premier échec sans état connu ; sinon au seuil (2 par défaut, réglable)', async () => {
    const { shouldAlertOnFailure, alertThreshold } = await import('../cguv-referential.service');
    expect(alertThreshold({})).toBe(2);
    expect(alertThreshold({ LEGAL_MANIFEST_ALERT_AFTER_FAILURES: '5' })).toBe(5);
    expect(alertThreshold({ LEGAL_MANIFEST_ALERT_AFTER_FAILURES: '0' })).toBe(2);
    expect(shouldAlertOnFailure(1, null, 2)).toBe(true);
    expect(shouldAlertOnFailure(1, new Date(), 2)).toBe(false);
    expect(shouldAlertOnFailure(2, new Date(), 2)).toBe(true);
  });
});

describe('L102B-04 — preuve : permalien et empreinte selon l’origine de la version', () => {
  it('version publique : permalien et empreinte du manifeste ; archive republiée : correspondance publique ; archive seule : permalien historique de l’application', async () => {
    const { versionProofInfo } = await import('../cguv-referential.service');
    const base = { versionCode: '2026-11-15-v1', permalink: 'https://www.verebona.fr/legal/cguv/versions/2026-11-15-v1', sha256: SHA, publicPermalink: null, publicSha256: null };
    expect(versionProofInfo({ ...base, source: 'PUBLIC_SITE' }, 'https://app.test')).toEqual({ permalinkUrl: base.permalink, sha256: SHA });
    const legacy = { versionCode: '2026-07-30-v1', permalink: '/cgvu/versions/2026-07-30-v1', sha256: 'c'.repeat(64), source: 'APP_LEGACY' as const };
    expect(versionProofInfo({ ...legacy, publicPermalink: null, publicSha256: null }, 'https://app.test/'))
      .toEqual({ permalinkUrl: 'https://app.test/cguv/versions/2026-07-30-v1', sha256: 'c'.repeat(64) });
    expect(versionProofInfo({ ...legacy, publicPermalink: 'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1', publicSha256: 'c'.repeat(64) }, 'https://app.test'))
      .toEqual({ permalinkUrl: 'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1', sha256: 'c'.repeat(64) });
    // Lot 104A (P1-D) : empreinte publique ≠ empreinte historique → jamais le permalien public.
    expect(versionProofInfo({ ...legacy, publicPermalink: 'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1', publicSha256: 'd'.repeat(64) }, 'https://app.test'))
      .toEqual({ permalinkUrl: 'https://app.test/cguv/versions/2026-07-30-v1', sha256: 'c'.repeat(64) });
  });
});

describe('L102B-05 — réacceptation : règles d’accès', () => {
  it.each([
    ['POST', '/api/assets'], ['PATCH', '/api/assets/12'], ['DELETE', '/api/documents/3'], ['POST', '/api/verebona/ask'],
    ['POST', '/api/billing/create-checkout-session'], ['PUT', '/api/users/me'],
  ])('L102B-05a — écriture métier refusée : %s %s', (method, path) => {
    expect(isApiAllowedDuringReacceptance(path, method)).toBe(false);
  });

  it.each([
    ['GET', '/api/assets'], ['GET', '/api/users/me'], ['POST', '/api/me/legal/cguv/accept'], ['POST', '/api/auth/logout'],
    ['POST', '/api/users/me/gdpr-export'], ['GET', '/api/users/me/gdpr-export/download'], ['POST', '/api/users/me/deletion'],
    ['POST', '/api/billing/cancel-subscription'], ['POST', '/api/withdrawal/public/request'], ['POST', '/api/admin/legal/cguv'],
    ['POST', '/api/auth/refresh'], ['HEAD', '/api/assets'],
  ])('L102B-05b — reste permis : %s %s (lecture, acceptation, déconnexion, export, suppression, résiliation, rétractation, BO)', (method, path) => {
    expect(isApiAllowedDuringReacceptance(path, method)).toBe(true);
  });

  it('L102B-05c — un préfixe n’ouvre pas un chemin voisin', () => {
    expect(isApiAllowedDuringReacceptance('/api/users/me/gdpr-exportx', 'POST')).toBe(false);
    expect(isApiAllowedDuringReacceptance('/api/adminx/foo', 'POST')).toBe(false);
  });

  it('L102B-05d — refus : 403 au code stable CGUV_REACCEPTANCE_REQUIRED, message en français, jamais une déconnexion', async () => {
    const { sessionErrorToResponse, isKnownSessionError } = await import('@/lib/auth/session-errors');
    const err = new Error(CGUV_REACCEPTANCE_REQUIRED_CODE);
    expect(isKnownSessionError(err)).toBe(true);
    const res = sessionErrorToResponse(err, 'req-1');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CGUV_REACCEPTANCE_REQUIRED');
    expect(body.message).toMatch(/CGUV/);
  });

  it('L102B-05e — garde branchée dans SessionService ET session-guard (écritures uniquement), écran dédié dans la coquille', () => {
    expect(lire('src/lib/session-service.ts')).toMatch(/isMutatingMethod\(request\.method\)[\s\S]{0,200}isApiAllowedDuringReacceptance/);
    expect(lire('src/lib/auth/session-guard.ts')).toMatch(/isReacceptanceRequired/);
    const shell = lire('src/components/DashboardLayout.tsx');
    expect(shell).toContain('<CguvReacceptanceScreen');
    expect(shell).toContain('CGUV_REACCEPTANCE_EVENT');
    expect(lire('src/lib/api-client.ts')).toContain('CGUV_REACCEPTANCE_REQUIRED_CODE');
    const screen = lire('src/components/shell/CguvReacceptanceScreen.tsx');
    for (const t of ['Accepter et continuer', 'Exporter mes données', 'Se déconnecter', 'Lire les CGUV', '/api/me/legal/cguv/accept']) expect(screen).toContain(t);
    // Case NON pré-cochée.
    expect(screen).toMatch(/useState\(false\)/);
  });

  it('L102B-05f — règle de calcul : dernière version substantielle en vigueur, acceptée elle-même ou via une version postérieure ; seul « non requis » est mis en cache', () => {
    const src = lire('src/services/legal/cguv-reacceptance.service.ts');
    expect(src).toMatch(/requires_reacceptance/);
    expect(src).toMatch(/status IN \('CURRENT', 'ARCHIVED'\)/);
    expect(src).toMatch(/COALESCE\(effective_at, published_at\) <= now\(\)/);
    expect(src).toMatch(/v\.published_at >= s\.published_at/);
    // Lot 104A : seul un « non requis » est mis en cache ; contrôle impossible ≠ non requis.
    expect(src).toMatch(/decision\.status === 'not_required'\) \{[\s\S]{0,120}serverCacheSet/);
    expect(src).toMatch(/throw new Error\(CGUV_CHECK_UNAVAILABLE_CODE\)/);
  });
});

describe('L102B-06 — liens publics, canal, terminologie', () => {
  it('L102B-06a — permalien d’une version et code de version', () => {
    expect(cguvVersionPath('2026-11-15-v1')).toBe('/legal/cguv/versions/2026-11-15-v1');
    expect(isCguvVersionCode('2026-11-15-v1')).toBe(true);
    expect(isCguvVersionCode('2026-13-01-v1')).toBe(false);
    expect(isCguvVersionCode('2026-11-15-v0')).toBe(false);
    expect(LEGAL_PUBLIC_PATHS.cguv).toBe('/legal/cguv');
  });

  it('L102B-06b — canal de la preuve : application iOS / Android (en-tête), vue intégrée (agent), sinon web', () => {
    expect(channelFrom('IOS', null)).toBe('IOS');
    expect(channelFrom('android', null)).toBe('ANDROID');
    expect(channelFrom('WEB', 'Mozilla/5.0 VerebonaApp/1.4.0')).toBe('MOBILE');
    expect(channelFrom(null, 'Mozilla/5.0')).toBe('WEB');
  });

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(rel, out);
      } else if (/\.tsx$/.test(name)) out.push(rel);
    }
    return out;
  }

  it('L102B-06c — interface : aucune mention CGSU / CGVU visible (hors commentaires et identifiants techniques de route)', () => {
    const fautifs: string[] = [];
    for (const f of [...walk('src/app'), ...walk('src/components')]) {
      const sans = lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')
        .replace(/['"`]\/(api\/)?(legal\/)?cgvu[^'"`]*['"`]/g, '').replace(/\/admin\/cgvu/g, '');
      if (/\bCG[SV]U\b/.test(sans)) fautifs.push(f);
    }
    expect(fautifs).toEqual([]);
  });

  it('L102B-06d — e-mails transactionnels : aucune mention CGSU / CGVU', () => {
    for (const f of ['src/lib/email/email-html-templates.ts', 'src/db/seeds/legal/email_template_cgvu.ts']) {
      const visible = lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(visible, f).not.toMatch(/\bCG[SV]U\b/);
    }
  });

  it('L102B-06e — inscription, connexion sociale, Mon compte : permalien public de la version présentée, plus de lien /cgvu', () => {
    for (const f of ['src/app/(auth)/signup/SignupForm.tsx', 'src/app/(auth)/connexion-sociale/page.tsx', 'src/components/account/LegalInformationCard.tsx']) {
      const src = lire(f);
      expect(src, f).toContain('/api/legal/cguv/current');
      expect(src, f).toContain('useLegalLinks()');
      expect(src, f).not.toMatch(/['"]\/cgvu['"]/);
    }
  });
});

describe('L102B-07 — plus aucun texte juridique servi ni maintenu par l’application', () => {
  it('L102B-07a — amorçages de textes retirés (fichiers et commandes), seul le gabarit d’e-mail reste', () => {
    for (const f of ['seed-cgvu.ts', 'seed-cgvu-draft.ts', 'cgvu-v1.content.ts', 'cgvu-2026-09-25.content.ts']) {
      expect(existsSync(join(ROOT, 'src/db/seeds/legal', f)), f).toBe(false);
    }
    const pkg = lire('package.json');
    expect(pkg).not.toMatch(/db:seed:cgvu"|db:seed:cgvu-draft/);
    const seed = lire('src/app/api/cron/seed/route.ts');
    expect(seed).not.toMatch(/seedCgvuV1|seed-cgvu'/);
    expect(seed).toContain('cguv-referentiel');
  });

  it('L102B-07b — plus de rédaction ni de publication de texte (createDraft / publishVersion retirés)', () => {
    const svc = lire('src/services/legal/legal-versions.service.ts');
    expect(svc).not.toMatch(/export async function (createDraft|publishVersion)/);
    expect(lire('src/services/legal/index.ts')).not.toMatch(/createDraft|publishVersion/);
  });

  it('L102B-07c — /cgvu, /cguv, /api/legal/cgvu/* : redirections ; plus aucun `htmlContent` servi comme version courante', () => {
    for (const f of ['src/app/cgvu/route.ts', 'src/app/cguv/route.ts', 'src/app/api/legal/cgvu/current/route.ts']) {
      expect(lire(f), f).toContain('redirectToPublicCguv');
      expect(lire(f), f).not.toContain('htmlContent');
    }
    for (const f of ['src/app/cgvu/versions/[version]/route.ts', 'src/app/cguv/versions/[version]/route.ts',
      'src/app/api/legal/cgvu/versions/[version]/route.ts', 'src/app/api/legal/cgvu/versions/[version]/download/route.ts']) {
      expect(lire(f), f).toContain('respondCguvVersion');
    }
    // Seule exception : archive de preuve APP_LEGACY non republiée, marquée.
    const redirects = lire('src/services/legal/legal-redirects.ts');
    expect(redirects).toContain("'X-Legal-Source': 'archive-historique'");
    expect(redirects).toMatch(/found\.source === 'APP_LEGACY' && !hasVerifiedPublicLink\(found\)/);
  });

  it('L102B-07d — contrôle d’intégrité : archives APP_LEGACY seulement (le texte public est vérifié par empreinte au manifeste)', () => {
    expect(lire('src/services/legal/legal-versions.service.ts')).toMatch(/v\.source === 'APP_LEGACY'/);
  });
});

describe('L102B-08 — demande expresse de démarrage immédiat', () => {
  it('L102B-08a — seule une case explicitement cochée (booléen vrai) vaut demande', () => {
    expect(isImmediateStartRequested({ [IMMEDIATE_START_FIELD]: true })).toBe(true);
    for (const v of [undefined, false, 'true', 1, null]) expect(isImmediateStartRequested({ [IMMEDIATE_START_FIELD]: v })).toBe(false);
  });

  it('L102B-08b — libellé factuel (aucun texte juridique), remboursement intégral rappelé, renvoi aux CGUV publiques ; case non pré-cochée sur les trois entrées', () => {
    expect(IMMEDIATE_START_LABEL).toMatch(/commence dès le paiement/);
    expect(IMMEDIATE_START_HINT).toMatch(/remboursé intégralement/);
    const consent = lire('src/components/billing/ImmediateStartConsent.tsx');
    expect(consent).toContain('legal.cguv');
    for (const f of ['src/app/abonnement/checkout/page.tsx', 'src/app/abonnement/onboarding/page.tsx']) {
      const src = lire(f);
      expect(src, f).toMatch(/const \[immediateStart, setImmediateStart\] = useState\(false\)/);
      expect(src, f).toContain('IMMEDIATE_START_FIELD');
    }
    const offres = lire('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect(offres).toContain('<ImmediateStartDialog');
    expect(lire('src/components/billing/ImmediateStartDialog.tsx')).toMatch(/disabled=\{!checked \|\| busy\}/);
  });

  it('L102B-08c — aucune déduction en cas de rétractation (décision PO) : le service de rétractation n’est pas touché par ce lot', () => {
    expect(lire('src/services/legal/immediate-start.service.ts')).toMatch(/Aucune déduction/);
    expect(lire('src/services/withdrawal/withdrawal-processor.service.ts')).not.toMatch(/IMMEDIATE_START/);
  });
});

describe('L102B-09 — migration, tâche planifiée, diagnostic', () => {
  const sql = lire('src/db/migrations/0910_l102b_source_juridique_publique.sql');

  it('L102B-09a — migration additive et idempotente : aucune table ni donnée supprimée', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|DROP\s+COLUMN/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS version_code/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS legal_manifest_sync_state/);
    // Preuves existantes : HISTORIQUE, code recopié, aucune empreinte inventée.
    expect(sql).toMatch(/SET proof_status = 'HISTORIQUE',\s+version_code = v\.version_code/);
    expect(sql).not.toMatch(/SET[^;]*text_sha256\s*=/);
    // Décision « substantielle » toujours figée (déclencheur 0115 conservé).
    expect(sql).not.toMatch(/DROP TRIGGER IF EXISTS legal_versions_guard_trg/);
  });

  it('L102B-09b — tâche planifiée horaire, « Relire le manifeste » = même fonction', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'legal-cguv-manifest-sync');
    expect(t?.schedule).toEqual({ kind: 'interval', everyMs: 3_600_000 });
    expect(lire('src/app/api/admin/legal/cguv/route.ts')).toMatch(/syncCguvManifest\(\{ trigger: 'bo'/);
  });

  it('L102B-09c — diagnostic global : nouvelle table déclarée', async () => {
    const { TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage') as unknown as { TABLE_COVERAGE?: Record<string, unknown> };
    const src = lire('src/services/admin/diagnostics-export/coverage.ts');
    expect(src).toContain('legal_manifest_sync_state');
    expect(lire('src/services/admin/diagnostics-export/recette-catalog.ts')).toContain('legal_manifest_sync_state');
    void TABLE_COVERAGE;
  });

  it('L102B-09d — contrat d’interface rédigé pour le site public, sans texte juridique', () => {
    const doc = lire('docs/exploitation/contrat-site-public-legal.md');
    for (const t of ['/legal/cguv/versions.json', 'requiresReacceptance', 'sha256', 'AAAA-MM-JJ-vN', 'verebona-legal-cguv-versions-v1', '301']) expect(doc).toContain(t);
  });
});


describe('L102B-10 — repli des liens légaux (site public pas encore livré)', () => {
  it('L102B-10a — mode : auto = repli tant que le manifeste n’a jamais été lu, nouvelles adresses ensuite ; LEGAL_PUBLIC_V2=on/off force', async () => {
    const { decideLegalLinksMode } = await import('@/lib/legal/public-legal');
    expect(decideLegalLinksMode(undefined, false)).toBe('legacy');
    expect(decideLegalLinksMode('', true)).toBe('v2');
    expect(decideLegalLinksMode('auto', true)).toBe('v2');
    expect(decideLegalLinksMode('on', false)).toBe('v2');
    expect(decideLegalLinksMode('off', true)).toBe('legacy');
  });

  it('L102B-10b — adresses actuelles par défaut (/cgu, /mentions-legales, /confidentialite ; sous-traitants → Confidentialité, parrainage → CGU), /legal/… en v2', async () => {
    const { resolveLegalLinks } = await import('@/lib/legal/public-legal');
    expect(resolveLegalLinks('legacy', 'https://www.verebona.fr/')).toEqual({
      mentionsLegales: 'https://www.verebona.fr/mentions-legales', cguv: 'https://www.verebona.fr/cgu',
      confidentialite: 'https://www.verebona.fr/confidentialite', sousTraitants: 'https://www.verebona.fr/confidentialite',
      parrainage: 'https://www.verebona.fr/cgu',
    });
    expect(resolveLegalLinks('v2', 'https://preprod.verebona.fr')).toEqual({
      mentionsLegales: 'https://preprod.verebona.fr/legal/mentions-legales', cguv: 'https://preprod.verebona.fr/legal/cguv',
      confidentialite: 'https://preprod.verebona.fr/legal/confidentialite', sousTraitants: 'https://preprod.verebona.fr/legal/sous-traitants',
      parrainage: 'https://preprod.verebona.fr/legal/parrainage',
    });
  });

  it('L102B-10c — surcharge par contenu (mapping unique partagé avec 102D) : URL absolue ou chemin, prioritaire dans les deux modes', async () => {
    const { resolveLegalHref, LEGAL_URL_ENV } = await import('@/lib/legal/public-legal');
    expect(LEGAL_URL_ENV.parrainage).toBe('NEXT_PUBLIC_LEGAL_REFERRAL_URL');
    expect(LEGAL_URL_ENV.confidentialite).toBe('NEXT_PUBLIC_LEGAL_PRIVACY_URL');
    expect(resolveLegalHref('parrainage', 'legacy', 'https://www.verebona.fr', { parrainage: 'https://aide.verebona.fr/parrainage' })).toBe('https://aide.verebona.fr/parrainage');
    expect(resolveLegalHref('confidentialite', 'v2', 'https://www.verebona.fr', { confidentialite: 'politique' })).toBe('https://www.verebona.fr/politique');
    expect(resolveLegalHref('cguv', 'v2', 'https://www.verebona.fr', { cguv: '  ' })).toBe('https://www.verebona.fr/legal/cguv');
  });

  it('L102B-10d — serveur : variables lues à l’exécution, NEXT_PUBLIC_LEGAL_*_URL comprises ; mode explicite sans lecture de la base', async () => {
    const { serverLegalOverrides, getLegalLinksMode } = await import('../cguv-referential.service');
    expect(serverLegalOverrides({ NEXT_PUBLIC_LEGAL_REFERRAL_URL: '/x' }).parrainage).toBe('/x');
    expect(await getLegalLinksMode({ LEGAL_PUBLIC_V2: 'on' })).toBe('v2');
    expect(await getLegalLinksMode({ LEGAL_PUBLIC_V2: 'off' })).toBe('legacy');
    // Base injoignable (mock vide) : repli sur les adresses actuelles, qui existent.
    expect(await getLegalLinksMode({})).toBe('legacy');
  });

  it('L102B-10e — manifeste absent et jamais lu : information (pas incident) ; publié mais invalide, ou absent après une lecture réussie : incident', async () => {
    const { isAwaitingPublicSite } = await import('../cguv-referential.service');
    expect(isAwaitingPublicSite(null, 'unavailable')).toBe(true);
    expect(isAwaitingPublicSite(null, 'invalid')).toBe(false);
    expect(isAwaitingPublicSite(new Date(), 'unavailable')).toBe(false);
    const task = lire('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(task).toMatch(/r\.status === 'awaiting_public_site'[\s\S]{0,200}return \{ note:/);
  });

  it('L102B-10f — preuve « en attente du site public » pour une version connue seulement par son archive applicative', async () => {
    const { proofStatusFor } = await import('../cguv-referential.service');
    const h = 'c'.repeat(64);
    expect(proofStatusFor({ source: 'APP_LEGACY', sha256: h, publicPermalink: null, publicSha256: null })).toBe('EN_ATTENTE_SITE_PUBLIC');
    expect(proofStatusFor({ source: 'APP_LEGACY', sha256: h, publicPermalink: 'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1', publicSha256: h })).toBe('COMPLETE');
    // Lot 104A (P1-D) : rattachement d'empreinte différente → l'archive d'origine reste la référence.
    expect(proofStatusFor({ source: 'APP_LEGACY', sha256: h, publicPermalink: 'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1', publicSha256: 'd'.repeat(64) })).toBe('EN_ATTENTE_SITE_PUBLIC');
    expect(proofStatusFor({ source: 'PUBLIC_SITE', sha256: h, publicPermalink: null, publicSha256: null })).toBe('COMPLETE');
  });

  it('L102B-10g — aucune réacceptation tant que le manifeste n’a jamais été lu', () => {
    expect(lire('src/services/legal/cguv-reacceptance.service.ts')).toMatch(/legal_manifest_sync_state m[\s\S]{0,120}last_success_at IS NOT NULL/);
  });

  it('L102B-10h — navigateur : liens de départ = repli (build), puis liens du serveur (`/api/legal/links`, public) ; jamais un lien relatif', () => {
    const hook = lire('src/hooks/useLegalLinks.ts');
    expect(hook).toContain("fetch('/api/legal/links'");
    expect(hook).toMatch(/clientLegalLinks\(\)/);
    expect(lire('src/middleware.ts')).toContain("pathname === '/api/legal/links'");
  });
});
