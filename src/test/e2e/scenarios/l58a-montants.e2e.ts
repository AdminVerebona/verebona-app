/**
 * Lot 58A — BUG P1 « troncature des montants » : chaîne complète sur
 * PostgreSQL réel, par les ROUTES de production (session simulée).
 *
 * Texte saisi → conversion client (`parseNumberInput`, comme le champ) →
 * PATCH / POST → normalisation serveur (registre canonique) →
 * `key_characteristics.acquisitionPrice` (EUROS) → miroir
 * `purchase_price_cents` (CENTIMES) → journal `canonical_field_writes` →
 * GET de la fiche (relecture après rechargement).
 *
 * Aucun montant historique n'est modifié (pas de migration de données).
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import { MONEY_INPUT, parseMoneyInputToCents, parseNumberInput } from '@/lib/number-input';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, unknown>;

const CAS: [string, string, number, number][] = [
  ['MONTANT-01', '20', 20, 2000],
  ['MONTANT-02', '200', 200, 20000],
  ['MONTANT-03', '1250', 1250, 125000],
  ['MONTANT-04', '12500', 12500, 1250000],
  ['MONTANT-05', '125000', 125000, 12500000],
  ['MONTANT-06', '12500,50', 12500.5, 1250050],
  ['MONTANT-07', '12 500,50', 12500.5, 1250050],
  ['MONTANT-08', '0', 0, 0],
];

scenario('L58A', 'Montants : saisie → API → BDD → relecture, euros/centimes, journal canonique', ({ sql, make }) => {
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });

  function connecter(c: AccountRow) {
    session.currentAccountId = c.id;
    session.userId = c.ownerUserId;
  }
  async function patcher(assetId: number, fields: Json) {
    const { PATCH } = await import('@/app/api/assets/[id]/details/[section]/route');
    const r = await PATCH(req('PATCH', `/api/assets/${assetId}/details/common`, { fields }), { params: Promise.resolve({ id: String(assetId), section: 'common' }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function fiche(assetId: number) {
    const { GET } = await import('@/app/api/assets/[id]/details/route');
    const r = await GET(req('GET', `/api/assets/${assetId}/details`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(r.status).toBe(200);
    return ((await r.json()) as { sections: { common: Json } }).sections.common;
  }
  async function base(assetId: number) {
    // `key_characteristics` est une colonne TEXT (JSON sérialisé).
    const [row] = await sql<{ kc: string | null; cents: string | null }[]>`
      SELECT key_characteristics AS kc, purchase_price_cents::text AS cents FROM assets WHERE id = ${assetId}`;
    const kc = (row.kc ? JSON.parse(row.kc) : {}) as Json;
    // Clé effacée : retirée du JSON (lue null).
    return { acquisitionPrice: kc.acquisitionPrice ?? null, cents: row.cents === null ? null : Number(row.cents) };
  }
  async function dernierJournal(assetId: number) {
    const rows = await sql<{ new_value: unknown; old_value: unknown; origin: string; outcome: string; mirror_columns: Json | null }[]>`
      SELECT new_value, old_value, origin, outcome, mirror_columns FROM canonical_field_writes
       WHERE asset_id = ${assetId} AND canonical_key = 'acquisitionPrice' ORDER BY id DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  it('MONTANT-01 à 08 — fiche « Informations générales » : PATCH → kc (euros) → miroir (centimes) → journal → GET', async () => {
    const compte = await make.account({ plan: 'premium' });
    connecter(compte);
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo Jean Fourche' });
    for (const [id, texte, euros, cents] of CAS) {
      const lu = parseNumberInput(texte, MONEY_INPUT);
      expect(lu, id).toEqual({ ok: true, value: euros });
      const r = await patcher(velo.id, { acquisitionPrice: lu.ok ? lu.value : null });
      expect(r.status, `${id} ${JSON.stringify(r.body)}`).toBe(200);
      expect(await base(velo.id), id).toEqual({ acquisitionPrice: euros, cents });
      const j = await dernierJournal(velo.id);
      expect(j, id).toMatchObject({ origin: 'USER', outcome: 'written' });
      expect(Number(j!.new_value), id).toBe(euros);
      expect(JSON.stringify(j!.mirror_columns ?? {}), id).toContain(String(cents));
      expect((await fiche(velo.id)).acquisitionPrice, id).toBe(euros);
    }
  });

  it('MONTANT-09 — effacement puis nouvelle saisie : null partout, puis la nouvelle valeur exacte', async () => {
    const compte = await make.account({ plan: 'premium' });
    connecter(compte);
    const bien = await make.asset(compte, { keyCharacteristics: { acquisitionPrice: 20 }, purchasePriceCents: 2000 });
    expect((await patcher(bien.id, { acquisitionPrice: null })).status).toBe(200);
    expect(await base(bien.id)).toEqual({ acquisitionPrice: null, cents: null });
    expect((await fiche(bien.id)).acquisitionPrice).toBeNull();
    expect((await patcher(bien.id, { acquisitionPrice: 12500.5 })).status).toBe(200);
    expect(await base(bien.id)).toEqual({ acquisitionPrice: 12500.5, cents: 1250050 });
    expect((await fiche(bien.id)).acquisitionPrice).toBe(12500.5);
  });

  it('MONTANT-10 — valeur ambiguë envoyée brute : 422 explicite, rien n’est écrit (ni kc, ni miroir, ni journal)', async () => {
    const compte = await make.account({ plan: 'premium' });
    connecter(compte);
    const bien = await make.asset(compte, { keyCharacteristics: { acquisitionPrice: 900 }, purchasePriceCents: 90000 });
    const avant = await dernierJournal(bien.id);
    for (const brut of ['20.000', '12,500', 'abc', '12,345']) {
      const r = await patcher(bien.id, { acquisitionPrice: brut });
      expect(r.status, brut).toBe(422);
      expect(String(r.body.message), brut).toMatch(/acquisitionPrice/);
    }
    expect(await base(bien.id)).toEqual({ acquisitionPrice: 900, cents: 90000 });
    expect(await dernierJournal(bien.id)).toEqual(avant);
    // Texte français non ambigu envoyé brut : lu à l'identique côté serveur.
    expect((await patcher(bien.id, { acquisitionPrice: '12 500,50' })).status).toBe(200);
    expect(await base(bien.id)).toEqual({ acquisitionPrice: 12500.5, cents: 1250050 });
  });

  it('MONTANT-12 — création d’un bien (AssetFormDialog) : centimes envoyés, euros relus sur la fiche', async () => {
    const { POST } = await import('@/app/api/assets/route');
    for (const [id, texte, euros, cents] of CAS.filter(([, , e]) => e > 0)) {
      // Un compte par création (plafond de biens de l'offre hors sujet ici).
      connecter(await make.account({ plan: 'premium' }));
      const prix = parseMoneyInputToCents(texte);
      expect(prix, id).toEqual({ ok: true, cents });
      const r = await POST(req('POST', '/api/assets', { name: `Vélo ${id}`, category: 'VEHICULE', purchasePriceCents: prix.ok ? prix.cents : null }));
      expect(r.status, id).toBe(201);
      const cree = (await r.json()) as { id: number; purchasePriceCents: number };
      expect(cree.purchasePriceCents, id).toBe(cents);
      expect((await fiche(cree.id)).acquisitionPrice, id).toBe(euros);
    }
  });

  it('MONTANT-19 — valorisation et forfait d’usage (TCO) : valeurs exactes en base', async () => {
    const compte = await make.account({ plan: 'premium' });
    connecter(compte);
    const bien = await make.asset(compte);
    const { POST: valoriser } = await import('@/app/api/assets/[id]/valuations/route');
    const v = parseNumberInput('12 500,50', MONEY_INPUT);
    const rv = await valoriser(req('POST', `/api/assets/${bien.id}/valuations`, { value: v.ok ? v.value : null, date: '2026-10-01' }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(rv.status).toBeLessThan(300);
    const [kc] = await sql<{ v: unknown }[]>`SELECT key_characteristics::jsonb->'estimatedValue' AS v FROM assets WHERE id = ${bien.id}`;
    expect(Number(kc.v)).toBe(12500.5);

    const { POST: forfait } = await import('@/app/api/assets/[id]/usage-budgets/route');
    const m = parseMoneyInputToCents('1 250,50');
    expect(m).toEqual({ ok: true, cents: 125050 });
    const rf = await forfait(req('POST', `/api/assets/${bien.id}/usage-budgets`, {
      category: 'FUEL', label: null, amountMinor: m.ok ? m.cents : null, currency: 'EUR', periodicity: 'MONTHLY', validFrom: null, validTo: null,
    }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(rf.status).toBe(201);
    const [b] = await sql<{ a: string }[]>`SELECT amount_minor::text AS a FROM asset_usage_budgets WHERE asset_id = ${bien.id}`;
    expect(Number(b.a)).toBe(125050);
  });
});
