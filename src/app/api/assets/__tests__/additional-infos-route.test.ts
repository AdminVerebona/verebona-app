/**
 * GET/PATCH /api/assets/[id]/additional-infos et GET /export-catalog —
 * authentification, accès par compte (Duo), refus inter-comptes, droits
 * d'écriture, validation, invalidation du cache de l'assistant.
 * CDC Exports V12 §4.3, §17, §26, DRH-001/002, EXP-001, EXP-002.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Données simulées ────────────────────────────────────────────────────────
// Compte 10 : titulaire (user 1) et co-titulaire Duo (user 2). Compte 20 : autre.
const ASSETS: Record<number, { id: number; accountId: number; category: string; subtype: string | null; status: string; lockState: string; address: null; postalCode: null; city: null }> = {
  5: { id: 5, accountId: 10, category: 'IMMOBILIER', subtype: 'Maison', status: 'ACTIVE', lockState: 'NONE', address: null, postalCode: null, city: null },
  6: { id: 6, accountId: 10, category: 'VEHICULE', subtype: 'Voiture', status: 'ACTIVE', lockState: 'NONE', address: null, postalCode: null, city: null },
  7: { id: 7, accountId: 10, category: 'IMMOBILIER', subtype: 'Maison', status: 'ACTIVE', lockState: 'LOCKED', address: null, postalCode: null, city: null },
  9: { id: 9, accountId: 20, category: 'IMMOBILIER', subtype: 'Maison', status: 'ACTIVE', lockState: 'NONE', address: null, postalCode: null, city: null },
};

let session: { userId: number; currentAccountId?: number | null } | null = { userId: 1, currentAccountId: 10 };
let writeDecision: { allowed: boolean; reason?: string; message?: string; limit?: number } = { allowed: true };

const getInfos = vi.fn();
const updateInfos = vi.fn();
const emitted: unknown[] = [];

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => {
      if (!session) throw new Error('AUTH_REQUIRED');
      return session;
    },
    handleSessionError: (e: Error) => NextResponse.json({ error: e.message }, { status: e.message === 'AUTH_REQUIRED' ? 401 : 500 }),
  },
}));

// Accès par compte : même règle que `export-access` (bien du compte courant).
vi.mock('@/services/exports/export-access', () => ({
  findAccessibleAssetForExport: async (s: { currentAccountId?: number | null }, assetId: number) => {
    const a = ASSETS[assetId];
    return a && s.currentAccountId && a.accountId === s.currentAccountId ? a : null;
  },
}));

vi.mock('@/services/asset-details-write.service', () => {
  class AssetDetailsError extends Error {
    constructor(public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
  }
  return {
    AssetDetailsError,
    loadWritableAsset: async (assetId: number, accountId: number) => {
      const a = ASSETS[assetId];
      if (!a || a.accountId !== accountId) throw new AssetDetailsError('NOT_FOUND', 'Asset not found');
      if (a.lockState !== 'NONE') throw new AssetDetailsError('ASSET_UNAVAILABLE', 'Ce bien est verrouillé par votre offre actuelle.', { reason: 'LOCKED_BY_PLAN' });
      if (!writeDecision.allowed) {
        throw new AssetDetailsError('WRITE_BLOCKED', writeDecision.message ?? 'Refus', { writeBlocked: { code: writeDecision.reason, limit: writeDecision.limit } });
      }
      return a;
    },
  };
});

vi.mock('@/services/exports/additional-infos.service', () => {
  class AdditionalInfosConflictError extends Error {
    constructor(public expectedVersion: number) { super('conflict'); }
  }
  return {
    AdditionalInfosConflictError,
    getAssetAdditionalInfos: (...a: unknown[]) => getInfos(...a),
    updateAssetAdditionalInfos: (...a: unknown[]) => updateInfos(...a),
  };
});

const loadReferences = vi.fn();
const invalidReferences = vi.fn();
vi.mock('@/services/exports/additional-infos-references.service', () => ({
  loadAdditionalInfoReferences: (...a: unknown[]) => loadReferences(...a),
  findInvalidReferences: (...a: unknown[]) => invalidReferences(...a),
}));

vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async (e: unknown) => { emitted.push(e); },
}));

const loadCatalog = vi.fn();
vi.mock('@/services/exports/export-catalog.service', () => ({
  loadExportCatalog: (...a: unknown[]) => loadCatalog(...a),
}));

const { GET, PATCH } = await import('../[id]/additional-infos/route');
const alias = await import('../[id]/additional-info/route');
const { GET: CATALOG } = await import('../[id]/export-catalog/route');

const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const get = (id: number | string) => GET(new NextRequest('http://x'), ctx(id));
const patch = (id: number | string, body: unknown, raw = false) => PATCH(
  new NextRequest('http://x', { method: 'PATCH', body: raw ? (body as string) : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  ctx(id),
);

const EMPTY = { assetId: 5, commercial: {}, rental: {}, insurance: {}, claim: {}, finance: {}, updatedAt: null, updatedBy: null, version: 0 };

beforeEach(() => {
  session = { userId: 1, currentAccountId: 10 };
  writeDecision = { allowed: true };
  emitted.length = 0;
  getInfos.mockReset().mockResolvedValue(EMPTY);
  updateInfos.mockReset().mockImplementation(async (assetId: number, _acc: number, userId: number) => ({
    ...EMPTY, assetId, rental: { depositCents: 0 }, updatedAt: '2026-09-28T10:00:00.000Z', updatedBy: userId, version: 1,
  }));
  loadReferences.mockReset().mockResolvedValue({ documents: [], photos: [], claimEvents: [], highlightSuggestions: [] });
  invalidReferences.mockReset().mockResolvedValue([]);
  loadCatalog.mockReset().mockResolvedValue({ assetId: 5, family: 'IMMOBILIER', dossiers: [], lastGenerations: [], eligibility: [] });
});

describe('GET /additional-infos', () => {
  it('sans session : 401', async () => {
    session = null;
    expect((await get(5)).status).toBe(401);
  });

  it('identifiant invalide : 400', async () => {
    expect((await get('abc')).status).toBe(400);
  });

  it('bien d’un autre compte : 404 sans révéler son existence', async () => {
    const res = await get(9);
    expect(res.status).toBe(404);
    expect(getInfos).not.toHaveBeenCalled();
  });

  it('bien inexistant et bien d’un autre compte : même réponse', async () => {
    const a = await (await get(9)).json();
    const b = await (await get(999)).json();
    expect(a).toEqual(b);
  });

  it('titulaire : sous-rubriques vides si rien n’est saisi, famille et sous-rubriques visibles', async () => {
    const res = await get(5);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ assetId: 5, commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null, updatedBy: null });
    expect(body.family).toBe('IMMOBILIER');
    expect(body.sections).toEqual(['commercial', 'rental', 'insurance', 'claim', 'finance']);
    expect(getInfos).toHaveBeenCalledWith(5, 10);
  });

  it('co-titulaire Duo (autre utilisateur, même compte) : accès', async () => {
    session = { userId: 2, currentAccountId: 10 };
    expect((await get(5)).status).toBe(200);
  });

  it('véhicule : pas de sous-rubrique locative', async () => {
    const body = await (await get(6)).json();
    expect(body.sections).toEqual(['commercial', 'insurance', 'claim', 'finance']);
  });

  it('alias CDC /additional-info : même implémentation', () => {
    expect(alias.GET).toBe(GET);
    expect(alias.PATCH).toBe(PATCH);
  });
});

describe('PATCH /additional-infos', () => {
  it('sans session : 401 ; sans compte courant : 404', async () => {
    session = null;
    expect((await patch(5, { rental: { depositCents: 0 } })).status).toBe(401);
    session = { userId: 1, currentAccountId: null };
    expect((await patch(5, { rental: { depositCents: 0 } })).status).toBe(404);
  });

  it('bien d’un autre compte : 404, rien n’est écrit', async () => {
    const res = await patch(9, { rental: { depositCents: 0 } });
    expect(res.status).toBe(404);
    expect(updateInfos).not.toHaveBeenCalled();
  });

  it('titulaire : fusion enregistrée, auteur et compte transmis, événement d’invalidation émis', async () => {
    const res = await patch(5, { rental: { depositCents: 0 }, commercial: { saleConditions: null } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ assetId: 5, rental: { depositCents: 0 }, updatedBy: 1, version: 1 });
    const [assetId, accountId, userId, normalized] = updateInfos.mock.calls[0];
    expect([assetId, accountId, userId]).toEqual([5, 10, 1]);
    expect(normalized).toEqual({ set: { rental: { depositCents: 0 } }, unset: { commercial: ['saleConditions'] } });
    expect(emitted).toEqual([{ type: 'ASSET_UPDATED', accountId: 10, entityId: 5 }]);
  });

  it('co-titulaire Duo : écriture admise, auteur = co-titulaire', async () => {
    session = { userId: 2, currentAccountId: 10 };
    const res = await patch(5, { insurance: { insuranceObjective: 'SOUSCRIRE' } });
    expect(res.status).toBe(200);
    expect((await res.json()).updatedBy).toBe(2);
    expect(updateInfos.mock.calls[0][2]).toBe(2);
  });

  it('validation : 422 VALIDATION_ERROR avec le détail par champ', async () => {
    const res = await patch(5, { commercial: { desiredSalePriceCents: 12.5, availabilityDate: '2026-13-01' } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.fields.map((f: { path: string }) => f.path).sort()).toEqual(['commercial.availabilityDate', 'commercial.desiredSalePriceCents']);
    expect(body.details.fields).toHaveLength(2);
    expect(updateInfos).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('location sur un véhicule : 422 (champ non applicable)', async () => {
    const res = await patch(6, { rental: { monthlyRentCents: 50000 } });
    expect(res.status).toBe(422);
  });

  it('JSON illisible : 400', async () => {
    expect((await patch(5, '{', true)).status).toBe(400);
  });

  it('compte restreint (impayé, essai terminé) : 403 lu par parseWriteBlocked', async () => {
    writeDecision = { allowed: false, reason: 'SUBSCRIPTION_REQUIRED', message: 'Paiement à régulariser avant le 30/09.' };
    const res = await patch(5, { rental: { depositCents: 0 } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', message: 'Paiement à régulariser avant le 30/09.' });
    const { parseWriteBlocked } = await import('@/lib/write-blocked');
    expect(parseWriteBlocked(body)?.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(updateInfos).not.toHaveBeenCalled();
  });

  it('quota dépassé : 403 ASSET_QUOTA_EXCEEDED', async () => {
    writeDecision = { allowed: false, reason: 'ASSET_QUOTA_EXCEEDED', message: 'Limite dépassée.', limit: 2 };
    const res = await patch(5, { rental: { depositCents: 0 } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ASSET_QUOTA_EXCEEDED');
  });

  it('bien verrouillé par l’offre : 403 ASSET_UNAVAILABLE', async () => {
    const res = await patch(7, { rental: { depositCents: 0 } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('ASSET_UNAVAILABLE');
  });

  it('erreur inattendue : 500 sans détail technique', async () => {
    updateInfos.mockRejectedValueOnce(new Error('connection reset by peer'));
    const res = await patch(5, { rental: { depositCents: 0 } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/connection reset/);
  });
});

describe('Listes structurées (schéma v2)', () => {
  const damages = [{ id: 'd1', zone: 'Salle de bain', photoIds: [11], documentIds: [21] }];

  it('GET ?include=references : éléments citables du bien, lus avec le compte et l’utilisateur', async () => {
    loadReferences.mockResolvedValueOnce({ documents: [{ id: 21, title: 'Devis' }], photos: [], claimEvents: [{ key: 'agenda:3' }], highlightSuggestions: [] });
    session = { userId: 2, currentAccountId: 10 };
    const body = await (await GET(new NextRequest('http://x/?include=references'), ctx(5))).json();
    expect(body.references.claimEvents).toEqual([{ key: 'agenda:3' }]);
    expect(loadReferences).toHaveBeenCalledWith({ assetId: 5, accountId: 10, userId: 2 });
    // Sans le paramètre : pas de lecture supplémentaire.
    loadReferences.mockClear();
    expect((await (await get(5)).json()).references).toBeUndefined();
    expect(loadReferences).not.toHaveBeenCalled();
  });

  it('liste avec version : écrite avec contrôle optimiste (version attendue transmise)', async () => {
    const res = await patch(5, { version: 4, claim: { damages } });
    expect(res.status).toBe(200);
    const [, , , normalized, opts] = updateInfos.mock.calls[0];
    expect(normalized.set.claim.damages).toEqual(damages);
    expect(opts).toEqual({ expectedVersion: 4 });
    expect(invalidReferences).toHaveBeenCalledWith(5, 10, normalized);
  });

  it('champs simples seuls : pas de contrôle de version (dernier écrit gagne)', async () => {
    await patch(5, { claim: { claimType: 'VOL' } });
    expect(updateInfos.mock.calls[0][4]).toEqual({ expectedVersion: null });
  });

  it('liste sans version : 422, rien n’est écrit', async () => {
    const res = await patch(5, { claim: { damages } });
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual([{ path: 'version', message: expect.any(String) }]);
    expect(updateInfos).not.toHaveBeenCalled();
  });

  it('ligne invalide : 422 avec le chemin de la cellule', async () => {
    const res = await patch(5, { version: 1, claim: { damages: [{ id: 'd1', element: 'Plafond' }] } });
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual([{ path: 'claim.damages[0].zone', message: 'Champ requis.' }]);
  });

  it('photo ou pièce d’un autre bien : 422, rien n’est écrit', async () => {
    invalidReferences.mockResolvedValueOnce([{ path: 'claim.damages[0].photoIds', message: 'Photo introuvable pour ce bien.' }]);
    const res = await patch(5, { version: 1, claim: { damages } });
    expect(res.status).toBe(422);
    expect((await res.json()).details.fields[0].message).toBe('Photo introuvable pour ce bien.');
    expect(updateInfos).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('version dépassée : 409 CONFLICT avec l’état courant, aucun événement émis', async () => {
    const { AdditionalInfosConflictError } = await import('@/services/exports/additional-infos.service');
    updateInfos.mockRejectedValueOnce(new AdditionalInfosConflictError(4));
    const current = { ...EMPTY, claim: { damages: [{ id: 'd9', zone: 'Cuisine' }] }, version: 6 };
    getInfos.mockResolvedValueOnce(current);
    const res = await patch(5, { version: 4, claim: { damages } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CONFLICT');
    expect(body.details.current).toEqual(current);
    expect(body.details.lists).toEqual(['claim.damages']);
    expect(getInfos).toHaveBeenCalledWith(5, 10);
    expect(emitted).toEqual([]);
  });

  it('sous-rubrique « Valeur et charges » : écriture admise pour un véhicule', async () => {
    const res = await patch(6, { version: 0, finance: { retainedValueCents: 1200000, charges: [{ kind: 'ASSURANCE', amountCents: 48000, period: 'AN' }] } });
    expect(res.status).toBe(200);
    expect(updateInfos.mock.calls[0][3].set.finance.charges[0]).toMatchObject({ kind: 'ASSURANCE', amountCents: 48000, id: 'r1' });
  });
});

describe('GET /export-catalog', () => {
  it('sans session : 401 ; autre compte : 404 ; Duo : 200', async () => {
    session = null;
    expect((await CATALOG(new NextRequest('http://x'), ctx(5))).status).toBe(401);
    session = { userId: 1, currentAccountId: 10 };
    expect((await CATALOG(new NextRequest('http://x'), ctx(9))).status).toBe(404);
    expect(loadCatalog).not.toHaveBeenCalled();
    session = { userId: 2, currentAccountId: 10 };
    const res = await CATALOG(new NextRequest('http://x'), ctx(5));
    expect(res.status).toBe(200);
    expect(loadCatalog.mock.calls[0][0]).toMatchObject({ id: 5, accountId: 10 });
  });
});
