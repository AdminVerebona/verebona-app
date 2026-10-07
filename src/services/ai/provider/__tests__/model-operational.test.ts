/**
 * Lot 32B (§1.H) — état opérationnel connu par modèle, avec l'empreinte de la
 * clé (jamais la clé) ; mis à jour par l'actualisation du catalogue, lu sans
 * appel fournisseur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ecrits: Array<{ sql: string; params: unknown[] }> = [];
let lignes: Array<Record<string, unknown>> = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (sql: string, params: unknown[]) => {
      ecrits.push({ sql, params });
      if (sql.includes('SELECT model, ok')) return lignes.filter((l) => l.key_fingerprint === params[0]);
      return [];
    },
  },
}));
let secret: string | null = 'cle-active';
vi.mock('../provider-secret', () => ({ getProviderSecret: async () => secret }));

const { keyFingerprint, loadOperationalStatuses, probeModels } = await import('../model-operational.service');
const { refreshModelCatalog } = await import('../model-catalog.service');

beforeEach(() => {
  ecrits.length = 0; lignes = []; secret = 'cle-active';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('MOD — état opérationnel par clé', () => {
  it('MOD-32 — empreinte non réversible ; seul l’état obtenu avec la clé ACTIVE est lu (rotation : état inconnu)', async () => {
    const fp = keyFingerprint('cle-active');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('cle');
    lignes = [
      { model: 'gemini-a', ok: false, error: '404', source: 'provider_test', checked_at: '2026-10-07T08:00:00Z', key_fingerprint: fp },
      { model: 'gemini-b', ok: false, error: '404', source: 'provider_test', checked_at: '2026-10-07T08:00:00Z', key_fingerprint: keyFingerprint('ancienne-cle') },
    ];
    const etats = await loadOperationalStatuses();
    expect([...etats.keys()]).toEqual(['gemini-a']);
    expect(etats.get('gemini-a')).toMatchObject({ ok: false, error: '404' });
    secret = null;
    expect((await loadOperationalStatuses()).size).toBe(0);
  });

  it('MOD-33 — sonde : génération minimale par modèle, état enregistré avec l’empreinte, secret jamais conservé', async () => {
    const r = await probeModels(['gemini-a', 'gemini-b'], 'cle-active', {
      call: async (m) => { if (m === 'gemini-b') throw new Error('404 cle-active no longer available'); return { rawText: 'OK' }; },
    });
    expect(r).toEqual([
      { model: 'gemini-a', ok: true, error: null },
      { model: 'gemini-b', ok: false, error: '404 *** no longer available' },
    ]);
    const inserts = ecrits.filter((e) => e.sql.includes('INSERT INTO ai_model_operational_status'));
    expect(inserts.map((e) => e.params.slice(0, 3))).toEqual([
      ['gemini-a', keyFingerprint('cle-active'), true], ['gemini-b', keyFingerprint('cle-active'), false],
    ]);
    expect(JSON.stringify(inserts)).not.toContain('cle-active');
  });

  it('MOD-34 — « Actualiser le catalogue » sonde les modèles DÉCLARÉS et listés (pas les autres) ; sans demande, aucune sonde', async () => {
    const listing = { models: ['gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-99-inconnu'].map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(listing), { status: 200 }));
    const sondes: string[] = [];
    const r = await refreshModelCatalog(1, fetcher as never, { probe: true, probeCall: async (m) => { sondes.push(m); return { rawText: 'OK' }; } });
    expect(r.ok).toBe(true);
    expect(sondes.sort()).toEqual(['gemini-3.1-flash-lite', 'gemini-3.6-flash']);
    expect(r.probed?.every((p) => p.ok)).toBe(true);
    sondes.length = 0;
    const sansSonde = await refreshModelCatalog(1, fetcher as never);
    expect(sansSonde.probed).toBeUndefined();
    expect(sondes).toEqual([]);
  });
});
