/**
 * Modules Gemini historiques — revue indépendante lot IA 2 (PROV-UI-05,
 * WF-21, OPS-011) : clé ACTIVE du BO et respect de l'arrêt d'urgence / de
 * l'état du traitement, au lieu de `process.env.GEMINI_API_KEY`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  requireLegacyGeminiKey, legacyGeminiKeyOrNull, legacyGeminiKeyForCleanup,
} from '../legacy-gemini-access';
import { setRuntimeSnapshotLoader } from '../../queue/runnable-guard';
import { setProviderSecretResolver } from '../provider-secret';

afterEach(() => {
  setRuntimeSnapshotLoader(null);
  setProviderSecretResolver(null);
});

describe('requireLegacyGeminiKey', () => {
  it('rend la clé active du BO (pas celle de l’environnement)', async () => {
    setProviderSecretResolver(async () => 'cle-bo');
    await expect(requireLegacyGeminiKey('T2', 'gemini-search')).resolves.toBe('cle-bo');
  });

  it('arrêt d’urgence : AI_BLOCKED, aucune clé délivrée', async () => {
    setProviderSecretResolver(async () => 'cle-bo');
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: true, states: {} }));
    await expect(requireLegacyGeminiKey('T1', 'gemini-client')).rejects.toMatchObject({ code: 'AI_BLOCKED' });
  });

  it('traitement désactivé : bloqué pour lui seul', async () => {
    setProviderSecretResolver(async () => 'cle-bo');
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: false, states: { T3: 'DISABLED' } }));
    await expect(requireLegacyGeminiKey('T3', 'enrich-and-coherence')).rejects.toMatchObject({ code: 'AI_BLOCKED' });
    await expect(requireLegacyGeminiKey('T2', 'gemini-search')).resolves.toBe('cle-bo');
  });

  it('aucune clé : erreur explicite', async () => {
    setProviderSecretResolver(async () => null);
    await expect(requireLegacyGeminiKey('T2', 'x')).rejects.toThrow(/Aucune clé Gemini/);
  });
});

describe('variantes', () => {
  it('legacyGeminiKeyOrNull : null si bloqué (repli déterministe de l’appelant)', async () => {
    setProviderSecretResolver(async () => 'cle-bo');
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: false, states: { T4: 'SUSPENDED' } }));
    await expect(legacyGeminiKeyOrNull('T4')).resolves.toBeNull();
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: false, states: {} }));
    await expect(legacyGeminiKeyOrNull('T4')).resolves.toBe('cle-bo');
  });

  it('nettoyage : jamais bloqué (pas de documents laissés chez le fournisseur)', async () => {
    setProviderSecretResolver(async () => 'cle-bo');
    setRuntimeSnapshotLoader(async () => ({ emergencyStop: true, states: {} }));
    await expect(legacyGeminiKeyForCleanup()).resolves.toBe('cle-bo');
  });
});

describe('régression : plus aucune lecture directe de GEMINI_API_KEY', () => {
  // Seuls la résolution de la clé (provider/) et le message de l'adaptateur
  // peuvent nommer la variable : l'environnement n'est qu'un amorçage.
  const AUTORISES = [
    'src/services/ai/provider/',
    'src/services/ai/gateway/providers/gemini.provider.ts',
    'src/test/',
  ];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

  it('aucun module applicatif ne lit process.env.GEMINI_API_KEY', () => {
    const racine = process.cwd();
    const fautifs = walk(join(racine, 'src'))
      .map((p) => p.slice(racine.length + 1))
      .filter((rel) => !AUTORISES.some((a) => rel.startsWith(a)))
      .filter((rel) => /process\.env\.GEMINI_API_KEY/.test(readFileSync(join(racine, rel), 'utf8')));
    expect(fautifs).toEqual([]);
  });
});
