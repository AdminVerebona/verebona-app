/**
 * Lot 110B — test d'ARCHITECTURE : absence de contournement de la garde MFA.
 *
 *   1. seuls les modules de session vérifient un jeton d'accès (tout autre
 *      appel de `verifyAccessToken` / `verifyToken` / `extractToken` ou
 *      lecture du cookie `access_token` échoue ici) ;
 *   2. INVENTAIRE DES ROUTES : chaque route `src/app/api/**` qui exige un jeton
 *      au middleware atteint (imports transitifs) `SessionService` ou
 *      `verifySessionAccessToken` — les deux seuls points porteurs de la garde
 *      MFA. Une route que le middleware laisse passer sans jeton doit figurer
 *      dans la liste PUBLIQUE ci-dessous (justifiée) : une nouvelle route
 *      publique, ou une nouvelle route métier hors garde, fait échouer le test ;
 *   3. routes `/api/auth/mfa/*` : exactement la liste fermée, chacune exige
 *      le contexte provisoire ou figure parmi les parcours anonymes justifiés ;
 *   4. step-up : aucune fonction métier (ZIP, dossiers, exports, transmission,
 *      biens, documents, agenda) ne demande de réauthentification.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { MFA_PENDING_ROUTES } from '../constants';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const read = (p: string) => readFileSync(p, 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'node_modules') walk(p, out); } else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$|\.e2e\.ts$/.test(f)) out.push(p);
  }
  return out;
}

// ── 1. Vérificateurs de jeton d'accès ─────────────────────────────────────
const TOKEN_VERIFIERS_ALLOWED = new Set([
  'src/middleware.ts', // Edge : signature seulement ; la garde MFA est dans les routes
  'src/lib/jwt.ts',
  'src/lib/session-service.ts',
  'src/lib/auth/session-guard.ts',
  'src/lib/auth/session-issuance.ts', // lecture du `sid` / niveau de la session présentée (émission)
  'src/lib/auth/token-extractor.ts',
  'src/lib/auth.ts',
]);

describe('L110B-ARCH-1 seuls les modules de session vérifient un jeton d’accès', () => {
  it('aucun autre module n’appelle verifyAccessToken / verifyToken / extractToken', () => {
    const fautifs = walk(SRC)
      .map((f) => relative(ROOT, f))
      .filter((f) => !TOKEN_VERIFIERS_ALLOWED.has(f))
      .filter((f) => /\bverifyAccessToken\(|\bverifyToken\(|\bextractToken\(/.test(read(join(ROOT, f))));
    expect(fautifs).toEqual([]);
  });
});

// ── 2. Inventaire des routes ──────────────────────────────────────────────
/** Routes laissées passer SANS jeton par le middleware — chacune se protège autrement (justification). */
const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  '/api/auth/login': 'preuve primaire → décision MFA centrale',
  '/api/auth/refresh': 'jeton de renouvellement ; niveau recopié, jamais promu',
  '/api/auth/logout': 'déconnexion',
  '/api/auth/verify-email': 'lien d’activation → décision MFA centrale',
  '/api/auth/resend-verification': 'renvoi non énumérant',
  '/api/auth/forgot-password': 'demande non énumérante',
  '/api/auth/reset-password': 'aucune session émise ; facteurs conservés',
  '/api/health': 'santé', '/api/health/live': 'santé', '/api/health/ready': 'santé',
  '/api/users': 'inscription',
  '/api/billing/stripe-webhook': 'signature Stripe',
  '/api/webhooks/resend': 'signature Svix',
  '/api/billing/catalog': 'catalogue public',
  '/api/contact': 'formulaire public',
  '/api/manifest': 'manifeste PWA',
  '/api/mobile/config': 'configuration publique de l’app',
  // Intégration lot 110 (110A) : jeton d'import seul (import, un espace, courte durée), émis derrière getSession ;
  // un jeton de niveau 1 est refusé (MFA_REQUIRED) dès que la double authentification est exigée.
  '/api/mobile/share-import/upload': 'jeton d’import borné ; niveau de preuve de la session émettrice revérifié',
  '/api/purge-pending-uploads': 'CRON_SECRET',
  '/api/duo/join': 'GET public par conception ; POST exige SessionService',
  '/api/duo/decline': 'refus sans compte ; session lue si présente (SessionService)',
  '/api/public/marketing/unsubscribe': 'jeton signé',
  '/api/public/marketing/signup-notice': 'information publique',
  '/api/internal/production-deletion-signals': 'HMAC serveur à serveur',
};
const PUBLIC_PREFIXES: Readonly<Record<string, string>> = {
  '/api/cron/': 'CRON_SECRET',
  '/api/referral/validate': 'validation publique',
  '/api/legal/': 'textes publics',
  '/api/withdrawal/public/': 'rétractation sans authentification (droit)',
  '/api/public/help-feedback': 'avis public',
  '/api/calendar/': 'flux ICS par jeton secret',
  '/api/transmission/': 'transmission : public par conception, session lue si présente',
  '/api/auth/oauth/': 'preuve Google / Apple → décision MFA centrale',
  '/api/auth/mfa/': 'seconde étape : contexte provisoire (liste fermée)',
};

/**
 * Routes protégées par le jeton du middleware mais SANS AUCUNE donnée : routes
 * retirées (410 fixe) et référentiel issu du code. Contrôle : elles
 * n'importent ni la base ni un service (si cela change, elles doivent passer
 * par SessionService et quitter cette liste).
 */
const NO_DATA_ROUTES: Readonly<Record<string, string>> = {
  'src/app/api/assets/[id]/delete-request/route.ts': 'retirée (410)',
  'src/app/api/assets/[id]/move-request/route.ts': 'retirée (410)',
  'src/app/api/billing/upgrade-apply/route.ts': 'retirée (410)',
  'src/app/api/billing/upgrade-preview/route.ts': 'retirée (410)',
  'src/app/api/delete-requests/[id]/respond/route.ts': 'retirée (410)',
  'src/app/api/document-types/route.ts': 'référentiel du code (aucune donnée de compte)',
  'src/app/api/duos/[id]/leave/route.ts': 'retirée (410)',
  'src/app/api/duos/[id]/recovery/assets/route.ts': 'retirée (410)',
  'src/app/api/duos/[id]/requests/inbox/route.ts': 'retirée (410)',
  'src/app/api/move-requests/[id]/respond/route.ts': 'retirée (410)',
};

function routeFiles(): string[] {
  return walk(join(SRC, 'app', 'api')).filter((f) => /\/route\.tsx?$/.test(f));
}
function urlOf(file: string): string {
  const rel = relative(join(SRC, 'app'), dirname(file)).split('\\').join('/');
  return '/' + rel.split('/').map((s) => (s.startsWith('[...') ? 'a/b' : s.startsWith('[') ? '1' : s)).filter((s) => !/^\(.*\)$/.test(s)).join('/');
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}
const GUARDS = new Set([join(SRC, 'lib', 'session-service.ts'), join(SRC, 'lib', 'auth', 'session-guard.ts')]);
const reachCache = new Map<string, boolean>();
function reachesGuard(entry: string): boolean {
  if (reachCache.has(entry)) return reachCache.get(entry)!;
  const seen = new Set<string>([entry]);
  const queue = [entry];
  let found = false;
  while (queue.length && !found) {
    const f = queue.shift()!;
    const src = read(f);
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolveImport(f, m[1] ?? m[2] ?? m[3]);
      if (!r || seen.has(r)) continue;
      if (GUARDS.has(r)) { found = true; break; }
      seen.add(r);
      queue.push(r);
    }
  }
  reachCache.set(entry, found);
  return found;
}

describe('L110B-ARCH-2 inventaire : toute route métier est sous la garde MFA', () => {
  it('chaque route soit publique justifiée, soit protégée par le middleware ET par SessionService / verifySessionAccessToken', async () => {
    const { middleware } = await import('@/middleware');
    const nonListedPublic: string[] = [];
    const notGuarded: string[] = [];
    for (const file of routeFiles()) {
      const url = urlOf(file);
      const res = await middleware(new NextRequest(`http://localhost:3000${url}`, { method: 'GET' }));
      const needsToken = res.status === 401;
      const isListed = url in PUBLIC_ROUTES || Object.keys(PUBLIC_PREFIXES).some((p) => url.startsWith(p));
      if (!needsToken) {
        if (!isListed) nonListedPublic.push(url);
        continue;
      }
      const rel = relative(ROOT, file);
      if (rel in NO_DATA_ROUTES) {
        expect(read(file), rel).not.toMatch(/from '@\/db'|from '@\/services\/|import\('@\/db'\)|pgClient/);
        continue;
      }
      if (!reachesGuard(file)) notGuarded.push(rel);
    }
    expect(nonListedPublic, 'route publique non répertoriée (justifier dans PUBLIC_ROUTES)').toEqual([]);
    expect(notGuarded, 'route protégée qui n’atteint pas la garde MFA').toEqual([]);
  }, 120_000);
});

// ── 3. Routes du contexte provisoire ──────────────────────────────────────
const MFA_ANONYMOUS_FLOWS: Readonly<Record<string, string>> = {
  '/api/auth/mfa/passkey/options': 'mode « login » : connexion par clé d’accès sans compte désigné (défi lié au navigateur)',
  '/api/auth/mfa/passkey/verify': 'mode « login » : vérification WebAuthn complète puis session de niveau 2',
  '/api/auth/mfa/recovery/start': 'récupération : réponse non énumérante',
  '/api/auth/mfa/recovery/verify': 'récupération : e-mail + code de récupération, aucune session (contexte d’enrôlement)',
  '/api/auth/mfa/cancel': 'abandon : aucun accès accordé',
};
describe('L110B-ARCH-3 routes /api/auth/mfa : liste fermée', () => {
  it('exactement MFA_PENDING_ROUTES ; chacune exige le contexte provisoire ou est un parcours anonyme justifié ; aucune n’émet de session sans preuve', () => {
    const files = routeFiles().filter((f) => urlOf(f).startsWith('/api/auth/mfa/'));
    expect(files.map(urlOf).sort()).toEqual([...MFA_PENDING_ROUTES].sort());
    for (const f of files) {
      const src = read(f);
      const url = urlOf(f);
      if (!(url in MFA_ANONYMOUS_FLOWS)) expect(src, url).toMatch(/withPending\(request/);
      expect(src, url).not.toMatch(/issueSession\(/);
      expect(src, url).not.toMatch(/generateAccessToken|generateRefreshToken|generateSessionTokens/);
    }
  });
});

// ── 4. Step-up : opérations de sécurité seulement ─────────────────────────
const STEP_UP_ALLOWED_DIRS = [
  'src/app/api/users/me/security/', 'src/app/api/users/me/password/', 'src/app/api/users/me/change-password/',
  'src/app/api/users/me/email-change/', 'src/app/api/users/me/deletion/', 'src/app/api/users/me/sessions/',
  'src/app/api/users/me/auth-identities/', 'src/lib/auth/', 'src/services/account/voluntary-deletion.service.ts',
];
describe('L110B-ARCH-4 aucun step-up pour une fonction métier', () => {
  it('requireFreshReauth / getReauthState / requireReauth / requireSecurityStepUp uniquement dans les opérations de sécurité', () => {
    const fautifs = walk(SRC).map((f) => relative(ROOT, f))
      .filter((f) => /\b(requireFreshReauth|getReauthState|requireReauth|requireSecurityStepUp)\(/.test(read(join(ROOT, f))))
      .filter((f) => !STEP_UP_ALLOWED_DIRS.some((d) => f.startsWith(d)));
    expect(fautifs).toEqual([]);
  });
  it('les routes ZIP, dossiers, exports, transmission, biens, documents, agenda n’importent aucune réauthentification', () => {
    const metier = routeFiles().map((f) => relative(ROOT, f)).filter((f) => /src\/app\/api\/(assets|documents|exports|export|transmission|agenda|deadlines|files|dossiers|zip)/.test(f));
    expect(metier.length).toBeGreaterThan(0);
    for (const f of metier) expect(read(join(ROOT, f)), f).not.toMatch(/lib\/auth\/reauth|mfa\/account-ops/);
  });
});
