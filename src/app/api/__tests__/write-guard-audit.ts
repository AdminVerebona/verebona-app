/**
 * Audit statique de la garde d'écriture des routes API — lot 85D.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN AUDIT STATIQUE
 *
 * La règle « un compte en lecture seule (essai échu, impayé, résilié,
 * rétractation, sans abonnement) ne peut rien modifier » n'est appliquée que
 * par les route handlers (`lib/write-access-guard`, `entitlements.service`) :
 * le middleware ne lit pas la base. Une route d'écriture qui oublie la garde
 * laisse passer l'écriture — c'était le cas de `DELETE /api/agenda/:id` et de
 * `PATCH /api/agenda/:id/statut` (constat du lot 84B).
 *
 * Ce module parcourt `src/app/api/**\/route.ts`, isole chaque méthode
 * d'écriture exportée (POST, PUT, PATCH, DELETE) et vérifie qu'elle appelle,
 * directement ou par une fonction locale, l'une des gardes reconnues
 * ci-dessous. Une route qui ne relève pas de la règle (facturation, compte,
 * RGPD, sécurité…) doit figurer dans la liste d'exceptions MOTIVÉES du test.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
type WriteMethod = (typeof WRITE_METHODS)[number];

/**
 * Gardes reconnues : export d'un module → condition d'appel. Chacune refuse
 * l'écriture quand `getEntitlements(...).canWrite` est faux (vérifié par le
 * test « chaque garde reconnue applique bien canWrite »).
 */
export const RECOGNIZED_GUARDS: ReadonlyArray<{ module: string; name: string; file: string; requires?: RegExp }> = [
  { module: '@/lib/write-access-guard', name: 'refuserSiLectureSeule', file: 'src/lib/write-access-guard.ts' },
  { module: '@/lib/write-access-guard', name: 'refuserSiPasDIA', file: 'src/lib/write-access-guard.ts' },
  { module: '@/lib/asset-quota-guard', name: 'refuserSiModificationBiensSuspendue', file: 'src/lib/asset-quota-guard.ts' },
  { module: '@/lib/asset-quota-guard', name: 'assetModificationDecision', file: 'src/lib/asset-quota-guard.ts' },
  { module: '@/services/entitlements.service', name: 'canCreateAsset', file: 'src/services/entitlements.service.ts' },
  { module: '@/services/entitlements.service', name: 'canModifyAssets', file: 'src/services/entitlements.service.ts' },
  { module: '@/services/entitlements.service', name: 'canAddDocument', file: 'src/services/entitlements.service.ts' },
  { module: '@/services/entitlements.service', name: 'canInviteUser', file: 'src/services/entitlements.service.ts' },
  { module: '@/services/entitlements.service', name: 'canUsePremiumFeature', file: 'src/services/entitlements.service.ts' },
  { module: '@/services/entitlements.service', name: 'canCreateDossiers', file: 'src/services/entitlements.service.ts' },
  // `getEntitlements` seul ne garde rien : il faut lire `canWrite` — ou
  // `premiumFeatures`, faux dans TOUS les états restreints
  // (`entitlementsFromSubscription`), donc une garde au moins aussi stricte.
  { module: '@/services/entitlements.service', name: 'getEntitlements', file: 'src/services/entitlements.service.ts', requires: /\.(?:canWrite|premiumFeatures)\b/ },
  { module: '@/services/assets/asset-route-helpers', name: 'writableAssetOr', file: 'src/services/assets/asset-route-helpers.ts' },
  { module: '@/services/asset-details-write.service', name: 'loadWritableAsset', file: 'src/services/asset-details-write.service.ts' },
  { module: '@/services/asset-details-write.service', name: 'updateAssetDetails', file: 'src/services/asset-details-write.service.ts' },
  // Socle du tiroir Pièce : la garde ne s'applique qu'avec `{ write: true }`.
  { module: '@/services/rooms/room-route', name: 'resolveRoomRoute', file: 'src/services/rooms/room-route.ts', requires: /resolveRoomRoute\([^;]*write:\s*true/ },
];

interface WriteHandler {
  /** Chemin relatif à `src/app/api`, ex. `agenda/[id]/route.ts`. */
  route: string;
  method: WriteMethod;
  guarded: boolean;
}

/** Code seul : un commentaire qui cite une garde n'est pas une garde. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

function listRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__') listRoutes(p, out);
    } else if (entry === 'route.ts') {
      out.push(p);
    }
  }
  return out;
}

/** Nom local → `module#export` (imports statiques et dynamiques). */
function importAliases(code: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const add = (names: string, mod: string) => {
    for (const raw of names.split(',')) {
      const part = raw.replace(/\btype\b/, '').trim();
      if (!part) continue;
      const [orig, local] = part.split(/\s+as\s+|\s*:\s*/).map((s) => s.trim());
      aliases.set(local || orig, `${mod}#${orig}`);
    }
  };
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) add(m[1], m[2]);
  for (const m of code.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], m[2]);
  return aliases;
}

/** Découpe en définitions de premier niveau : nom → corps. */
function topLevelDefinitions(code: string): Map<string, string> {
  const defs = new Map<string, string>();
  const lines = code.split('\n');
  const startRe = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/;
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current) defs.set(current, buf.join('\n')); };
  for (const line of lines) {
    const m = startRe.exec(line);
    if (m) {
      flush();
      current = m[1] ?? m[2];
      buf = [line];
    } else if (/^(?:export|import|type|interface|class|let|var)\b/.test(line)) {
      flush();
      current = null;
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return defs;
}

function callsGuard(body: string, aliases: Map<string, string>): boolean {
  for (const [local, target] of aliases) {
    const g = RECOGNIZED_GUARDS.find((x) => `${x.module}#${x.name}` === target);
    if (!g) continue;
    if (!new RegExp(`\\b${local}\\s*\\(`).test(body)) continue;
    if (g.requires) {
      const req = g.name === 'resolveRoomRoute' ? new RegExp(g.requires.source.replace('resolveRoomRoute', local)) : g.requires;
      if (!req.test(body)) continue;
    }
    return true;
  }
  return false;
}

/** Méthodes d'écriture d'un fichier de route et présence de la garde. */
export function analyzeRouteFile(file: string, apiRoot: string, seen = new Set<string>()): WriteHandler[] {
  const route = relative(apiRoot, file).split('\\').join('/');
  const code = stripComments(readFileSync(file, 'utf-8'));
  const aliases = importAliases(code);
  const defs = topLevelDefinitions(code);
  const memo = new Map<string, boolean>();
  const guarded = (name: string, stack: Set<string>): boolean => {
    if (memo.has(name)) return memo.get(name)!;
    const body = defs.get(name);
    if (body === undefined || stack.has(name)) return false;
    stack.add(name);
    let ok = callsGuard(body, aliases);
    if (!ok) {
      for (const other of defs.keys()) {
        if (other !== name && new RegExp(`\\b${other}\\b`).test(body) && guarded(other, stack)) { ok = true; break; }
      }
    }
    stack.delete(name);
    memo.set(name, ok);
    return ok;
  };

  const out: WriteHandler[] = [];
  for (const method of WRITE_METHODS) {
    if (defs.has(method) && new RegExp(`^export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`, 'm').test(code)) {
      out.push({ route, method, guarded: guarded(method, new Set()) });
    }
  }
  // Réexport (`export { GET, PATCH } from '../autre/route'`) : on suit la cible.
  for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const names = m[1].split(',').map((s) => s.trim());
    const target = resolve(dirname(file), m[2]) + '.ts';
    if (!existsSync(target) || seen.has(target)) continue;
    seen.add(target);
    const targetHandlers = analyzeRouteFile(target, apiRoot, seen);
    for (const method of WRITE_METHODS) {
      if (!names.includes(method)) continue;
      const t = targetHandlers.find((h) => h.method === method);
      out.push({ route, method, guarded: t?.guarded ?? false });
    }
  }
  return out;
}

export function auditWriteRoutes(root = process.cwd()): WriteHandler[] {
  const apiRoot = join(root, 'src/app/api');
  return listRoutes(apiRoot).sort().flatMap((f) => analyzeRouteFile(f, apiRoot));
}
