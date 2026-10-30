/**
 * Lot 100C — CVE-2026-111497 (« Node2Shell ») : sonde du runtime Node.
 *
 * R-01 seuils corrigés par majeure, majeures sans seuil, version illisible.
 * R-02 plage déclarée : package.json, métadonnées racine du lockfile, projet
 *      mobile et module applicatif portent la même plage.
 * R-03 contrôle de CI (`scripts/check-node-runtime.mjs`) : même tableau de
 *      seuils, échec sous 24.22.1.
 * R-04 journal du démarrage : version, binaire, verdict ; branché en tête.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_ENGINES_RANGE, NODE_PATCHED_THRESHOLDS, currentNodeRuntime, evaluateNodeRuntime, formatRuntimeLogLine, parseNodeVersion,
} from '../node-runtime';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('R-01 — verdict par ligne majeure', () => {
  it('seuils exacts du ticket', () => {
    expect(NODE_PATCHED_THRESHOLDS).toEqual({ 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' });
  });

  it.each([
    ['v24.22.1', 'patched', 'ok'],
    ['v24.30.0', 'patched', 'ok'],
    ['v24.22.0', 'vulnerable', 'error'],
    ['v24.9.9', 'vulnerable', 'error'],
    ['v22.13.0', 'vulnerable', 'error'],
    ['v22.23.3', 'vulnerable', 'error'],
    ['v22.23.4', 'patched', 'warning'], // corrigé mais hors plage déclarée
    ['v26.12.0', 'vulnerable', 'error'],
    ['v26.12.1', 'patched', 'warning'],
    ['v20.19.5', 'unsupported_major', 'error'],
    ['v25.1.0', 'unsupported_major', 'error'],
    ['v23.11.0', 'unsupported_major', 'error'],
    ['nimporte', 'unknown', 'error'],
  ])('%s → %s (%s)', (v, verdict, status) => {
    const r = evaluateNodeRuntime(v);
    expect(r.verdict).toBe(verdict);
    expect(r.status).toBe(status);
    expect(r.node).toBe(v);
    expect(r.enginesRange).toBe(NODE_ENGINES_RANGE);
    expect(r.message.length).toBeGreaterThan(10);
  });

  it('comparaison numérique (pas lexicale) et seuil exposé', () => {
    expect(parseNodeVersion('v24.100.0')).toEqual([24, 100, 0]);
    expect(evaluateNodeRuntime('v24.100.0').status).toBe('ok');
    expect(evaluateNodeRuntime('v24.3.0').patchedThreshold).toBe('24.22.1');
    expect(evaluateNodeRuntime('v24.22.1').withinEngines).toBe(true);
    expect(evaluateNodeRuntime('v25.0.0').withinEngines).toBe(false);
  });
});

describe('R-02 — même plage partout', () => {
  it('package.json, packages[""] du lockfile et module applicatif', () => {
    expect(JSON.parse(lire('package.json')).engines.node).toBe(NODE_ENGINES_RANGE);
    expect(JSON.parse(lire('package-lock.json')).packages[''].engines.node).toBe(NODE_ENGINES_RANGE);
    expect(NODE_ENGINES_RANGE).toBe('>=24.22.1 <25');
  });

  it('projet mobile aligné (package.json et racine de son lockfile)', () => {
    expect(JSON.parse(lire('mobile/package.json')).engines.node).toBe(NODE_ENGINES_RANGE);
    expect(JSON.parse(lire('mobile/package-lock.json')).packages[''].engines.node).toBe(NODE_ENGINES_RANGE);
  });

  it('workflows mobiles : version exacte corrigée et contrôle bloquant, plus aucune 22', () => {
    for (const f of ['.github/workflows/mobile-android.yml', '.github/workflows/mobile-ios.yml']) {
      const y = lire(f);
      const versions = [...y.matchAll(/node-version:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(versions.length).toBeGreaterThan(0);
      expect(new Set(versions)).toEqual(new Set(['24.22.1']));
      expect(y.match(/run: node scripts\/check-node-runtime\.mjs/g)?.length).toBe(versions.length);
    }
  });
});

describe('R-03 — contrôle de CI', () => {
  it('même tableau de seuils que le module applicatif', async () => {
    const m = await import('../../../../scripts/check-node-runtime.mjs');
    expect(m.NODE_PATCHED_THRESHOLDS).toEqual(NODE_PATCHED_THRESHOLDS);
  });

  it('échoue sous 24.22.1, hors plage ou plage illisible ; passe à 24.22.1', async () => {
    const { checkNodeRuntime } = await import('../../../../scripts/check-node-runtime.mjs');
    expect(checkNodeRuntime('v24.22.1', NODE_ENGINES_RANGE)).toEqual([]);
    expect(checkNodeRuntime('v24.23.0', NODE_ENGINES_RANGE)).toEqual([]);
    expect(checkNodeRuntime('v22.13.0', NODE_ENGINES_RANGE).join(' ')).toMatch(/22\.23\.4.*plage|sous la version corrigée/);
    expect(checkNodeRuntime('v24.22.0', NODE_ENGINES_RANGE)).toHaveLength(2);
    expect(checkNodeRuntime('v22.23.4', NODE_ENGINES_RANGE)).toEqual([`hors de la plage engines.node « ${NODE_ENGINES_RANGE} »`]);
    expect(checkNodeRuntime('v25.0.0', NODE_ENGINES_RANGE).length).toBe(2);
    expect(checkNodeRuntime('v24.22.1', '>=24').join(' ')).toMatch(/non reconnue/);
  });
});

describe('R-04 — journal du démarrage', () => {
  it('ligne avec version, binaire et verdict, sans variable d’environnement', () => {
    const r = currentNodeRuntime();
    expect(r.node).toBe(process.version);
    expect(r.execPath).toBe(process.execPath);
    const ligne = formatRuntimeLogLine({ ...evaluateNodeRuntime('v24.22.1'), execPath: '/app/.scalingo/node/bin/node' });
    expect(ligne).toContain('node=v24.22.1');
    expect(ligne).toContain('execPath=/app/.scalingo/node/bin/node');
    expect(ligne).toContain('verdict=patched');
  });

  it('journalisé AVANT toute autre étape, alerte de Supervision après les migrations', () => {
    const src = lire('src/instrumentation-node.ts');
    const log = src.indexOf('formatRuntimeLogLine(runtimeNode)');
    expect(log).toBeGreaterThan(0);
    expect(log).toBeLessThan(src.indexOf('\n  assertJwtSecretConfigured();'));
    const alerte = src.indexOf('syncNodeRuntimeAnomaly(runtimeNode)');
    expect(alerte).toBeGreaterThan(src.indexOf('assertMigrationBootPolicy(await ensureMigrations())'));
  });
});
