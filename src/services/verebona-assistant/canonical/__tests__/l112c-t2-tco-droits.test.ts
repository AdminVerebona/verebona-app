/**
 * Lot 112C (reprise) — T2 : droits du coût de possession et élision.
 *
 *   R01  coût de possession hors offre (Standard, lecture seule) : réponse
 *        sans montant, message de la fiche, lecture TCO JAMAIS exécutée ;
 *        avec l'offre : lecture TCO (inchangé) ; dépenses par thème inchangées ;
 *   R02  le port réel contrôle l'offre (même droit que la fiche) ;
 *   R03  « de » élidé devant voyelle / h muet dans les réponses déterministes.
 * Bout en bout (PostgreSQL, Standard / Premium / Duo / essai / lecture seule) :
 * `src/test/e2e/scenarios/l112c-t2-tco-droits.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { tryCanonicalStructured, ownershipCostLockedAnswer } = await import('../structured-answers');
const { deFr } = await import('../../core/deterministic-format');
const { EXPENSE_THEME_LABELS } = await import('../expense-classes');
const { TCO_PREMIUM_MESSAGE } = await import('@/services/business-operations/tco/dto');

const CUPRA = { id: 7, name: 'Cupra' };
const MONTANT = /\d[\d\s  ]*(,\d{2})?\s?€/;

function port(allowed: boolean | undefined) {
  const readOwnershipCost = vi.fn(async () => { throw new Error('ne doit pas être lu'); });
  return {
    readOwnershipCost,
    p: {
      today: () => '2026-11-06',
      readOwnershipCost,
      ...(allowed === undefined ? {} : { ownershipCostAllowed: vi.fn(async () => allowed) }),
      listAssets: async () => [CUPRA],
    } as never,
  };
}
const scope = (assets = [CUPRA], ambiguous = false) => async () => ({ assets, ambiguous, unresolved: assets.length === 0, label: assets[0]?.name ?? null }) as never;

describe('L112C-R01 — coût de possession hors offre : aucune valeur, lecture TCO non exécutée', () => {
  it.each(['Quel est le coût de possession de Cupra ?', 'Quel est le coût total de possession de Cupra ?', 'Quel est le TCO de Cupra ?'])('%s', async (q) => {
    const { p, readOwnershipCost } = port(false);
    const r = await tryCanonicalStructured({ port: p, accountId: 1, message: q, resolveScope: scope() });
    expect(r && 'strategy' in r ? r.strategy : r).toBe('structured.ownership_cost');
    const a = r as { answer: string; sources: Array<{ type: string; id: string; meta?: Record<string, unknown> }>; kind: string };
    expect(a.answer.startsWith(TCO_PREMIUM_MESSAGE)).toBe(true);
    expect(a.answer).not.toMatch(MONTANT);
    expect(a.sources).toEqual([expect.objectContaining({ id: 'product_rule:tco_premium', type: 'product_rule' })]);
    expect(JSON.stringify(a.sources)).not.toMatch(/Cents/);
    expect(a.kind).toBe('no_result');
    expect(readOwnershipCost).not.toHaveBeenCalled();
  });

  it('bien ambigu ou non désigné : la réservation est dite sans demander lequel (aucune lecture)', async () => {
    const { p, readOwnershipCost } = port(false);
    const r = await tryCanonicalStructured({ port: p, accountId: 1, message: 'Quel est le coût de possession ?', resolveScope: scope([], false) }) as { answer: string };
    expect(r.answer).toMatch(/Premium et Premium Duo/);
    const r2 = await tryCanonicalStructured({ port: p, accountId: 1, message: 'Quel est le coût de possession de Cupra ?', resolveScope: scope([CUPRA, { id: 8, name: 'Cupra Born' }], true) }) as { answer: string };
    expect(r2.answer).toMatch(/Premium et Premium Duo/);
    expect(readOwnershipCost).not.toHaveBeenCalled();
  });

  it('avec l’offre : la lecture TCO est exécutée (comportement inchangé)', async () => {
    const { p, readOwnershipCost } = port(true);
    await tryCanonicalStructured({ port: p, accountId: 1, message: 'Quel est le coût de possession de Cupra ?', resolveScope: scope() }).catch(() => null);
    expect(readOwnershipCost).toHaveBeenCalledWith(1, 7);
  });

  it('dépenses par thème / par année : jamais concernées par le verrou (Q3 / Q4 ouvertes à tous)', async () => {
    const { p } = port(false);
    const sum = vi.fn(async () => ({ theme: 'maintenance', byTheme: [{ theme: 'maintenance', label: 'entretien', sumCents: 43000, count: 2, fileIds: [1, 2] }], qualifiedSumCents: 43000, qualifiedCount: 2,
      unqualified: { count: 0, sumCents: 0, fileIds: [], undatedCount: 0 }, duplicates: { count: 0, fileIds: [] }, excluded: { count: 0, byType: {} }, complete: true }));
    const r = await tryCanonicalStructured({ port: { ...(p as object), sumQualifiedExpenses: sum } as never, accountId: 1, message: 'Combien ai-je dépensé en entretien pour Cupra ?', resolveScope: scope() }) as { strategy: string; answer: string };
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/^Dépenses d’entretien documentées pour Cupra : 430,00/);
  });

  it('réponse hors offre : sans bien, sans montant ; avec bien, une question ouverte à tous est suggérée', () => {
    const avec = ownershipCostLockedAnswer(CUPRA) as { answer: string };
    expect(avec.answer).toContain('« Combien ai-je dépensé en entretien pour Cupra ? »');
    const sans = ownershipCostLockedAnswer(null) as { answer: string };
    expect(sans.answer).not.toMatch(MONTANT);
  });
});

describe('L112C-R02 — le port réel contrôle l’offre au point d’accès de la lecture TCO', () => {
  it('readOwnershipCost refuse hors offre ; ownershipCostAllowed = premiumFeatures (erreur de lecture : refusé)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/canonical/repository.ts'), 'utf8');
    expect(src).toMatch(/if \(!\(await ownershipCostAllowed\(accountId\)\)\) throw new OwnershipCostNotAllowedError\(\);/);
    expect(src).toMatch(/e\.premiumFeatures === true\)\.catch\(\(\) => false\)/);
  });
});

describe('L112C-R03 — élision de « de » dans les réponses déterministes', () => {
  it('voyelle et h muet : « d’ » ; consonne et h aspiré : « de »', () => {
    expect(deFr('entretien')).toBe('d’entretien');
    expect(deFr('assurance')).toBe('d’assurance');
    expect(deFr('abonnements')).toBe('d’abonnements');
    expect(deFr('achat')).toBe('d’achat');
    expect(deFr('autres dépenses')).toBe('d’autres dépenses');
    expect(deFr('Électricité')).toBe('d’Électricité');
    expect(deFr('habitation')).toBe('d’habitation');
    expect(deFr('hébergement')).toBe('d’hébergement');
    expect(deFr('réparations')).toBe('de réparations');
    expect(deFr('travaux')).toBe('de travaux');
    expect(deFr('charges')).toBe('de charges');
    expect(deFr('contrôles et diagnostics')).toBe('de contrôles et diagnostics');
    expect(deFr('housse')).toBe('de housse');
    expect(deFr('hangar')).toBe('de hangar');
  });
  it('chaque thème de dépense est rendu correctement ; plus aucun « de » suivi d’une voyelle dans les gabarits', () => {
    for (const l of Object.values(EXPENSE_THEME_LABELS)) expect(deFr(l)).not.toMatch(/^de [aeiouéèêh]/i);
    for (const f of ['structured-answers.ts', 'expenses.ts']) {
      const t = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/canonical', f), 'utf8');
      expect(t, f).not.toMatch(/ de \$\{(EXPENSE_THEME_LABELS|t\.label)/);
    }
  });
});
