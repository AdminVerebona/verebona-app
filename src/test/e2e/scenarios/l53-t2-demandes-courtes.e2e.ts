/**
 * Lot 53 — 53H : « T2 : faire comprendre par l'IA les demandes courtes au
 * lieu de substituer une autre information », de bout en bout sur
 * PostgreSQL réel : `runAssistant` + PORTS RÉELS (`buildOrchestratorPorts`),
 * T2 en master, sorties UNDERSTAND rejouées par la vraie passerelle (aucun
 * réseau — `replay.calls` compte les appels LLM).
 *
 * Le PIÈGE de la préproduction est reconstitué : la Polo porte sa
 * motorisation (fiche canonique `engine`) ET un fait T1 « Motorisation »
 * extrait de sa carte grise, retrouvé par le seul mot « polo ». Avant le
 * lot 53, « date d'achat polo » répondait « Motorisation de Polo : TSI
 * BLUEMOTION. » (niveau 2, `retrieval.canonical_field`).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const ENGINE = 'TSI BLUEMOTION';
const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', confidence: 'exact', requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});
const DATE_ACHAT_POLO = understand({ intent: 'ACCOUNT_FACT_ASSET', entityHints: [{ type: 'asset', value: 'polo' }], requestedFacts: ['acquisitionDate'] });

/** Jamais la motorisation (libellé ni valeur) dans une réponse sur la date d'achat. */
const jamaisMotorisation = (answer: string) => {
  expect(answer).not.toMatch(/Motorisation/i);
  expect(answer).not.toContain(ENGINE);
  expect(answer.toUpperCase()).not.toContain(ENGINE);
};

scenario('L53-T2', 'Lot 53 — T2 demandes courtes : compréhension par UNDERSTAND, jamais de substitution', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let canon: typeof import('@/services/canonical/asset-state');
  beforeAll(async () => { canon = await import('@/services/canonical/asset-state'); });

  /** Compte avec la Polo (motorisation sur la fiche) et le fait T1 « Motorisation » de sa carte grise. */
  const comptePolo = async (): Promise<{ c: Compte; poloId: number }> => {
    const a = await make.account({ plan: 'premium' });
    const c = { id: a.id, ownerUserId: a.ownerUserId };
    const polo = await make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category: 'VEHICULE', name: 'Polo', keyCharacteristics: { engine: ENGINE, mileage: 82000 } });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${polo.id}`;
    await canon.writeCanonicalAssetField({ assetId: polo.id, accountId: c.id, key: 'engine', value: ENGINE, origin: 'USER' });
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: polo.id, name: 'Carte grise Polo.pdf' });
    const [ext] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title) VALUES (${c.id}, ${f.id}, 'Carte grise Polo') RETURNING id`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, subject, attribute, label, value_text, confidence, excerpt)
              VALUES (${c.id}, ${f.id}, ${ext.id}, 'engine', 'Polo', 'Motorisation', 'Motorisation', ${ENGINE}, 'certain', ${`POLO ${ENGINE}`})`;
    return { c, poloId: polo.id };
  };

  it('T2-SHORT-AC10 — le piège existe : la motorisation de la Polo est bien lisible (question explicite)', async () => {
    const { c } = await comptePolo();
    await useRecordings([]);
    const r = await demander(c, 'Quelle est la motorisation de la Polo ?');
    expect(r.answer).toContain(ENGINE);
  });

  it('T2-SHORT-AC10 — « date d’achat polo », valeur ABSENTE : absence explicite, jamais « Motorisation » ni la valeur de engine', async () => {
    const { c } = await comptePolo();
    const replay = await useRecordings([DATE_ACHAT_POLO]);
    const r = await demander(c, "date d'achat polo");
    jamaisMotorisation(r.answer);
    expect(r.answer).toBe('L’information « Date d’achat » n’est pas renseignée pour Polo.');
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r.cascade?.understanding?.reasons).toContain('UNDETERMINED_FIELD_REQUEST');
    expect(JSON.stringify(r.sources ?? [])).not.toContain(':engine');
  });

  it('T2-SHORT-AC10 — « date d’achat polo », valeur PRÉSENTE : la date d’achat seulement', async () => {
    const { c, poloId } = await comptePolo();
    await canon.writeCanonicalAssetField({ assetId: poloId, accountId: c.id, key: 'acquisitionDate', value: '2022-09-12', origin: 'USER' });
    const replay = await useRecordings([DATE_ACHAT_POLO]);
    const r = await demander(c, "date d'achat polo");
    jamaisMotorisation(r.answer);
    expect(r.answer).toBe('Vous avez acheté Polo le 12 septembre 2022.');
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r.sources.map((s) => s.id)).toEqual([`asset_field:${poloId}:acquisitionDate`]);
  });

  it('T2-SHORT-AC10 — UNDERSTAND indisponible (aucune sortie rejouée) : jamais « Motorisation », valeur présente ou absente', async () => {
    const { c, poloId } = await comptePolo();
    await useRecordings([]);
    const absente = await demander(c, "date d'achat polo");
    jamaisMotorisation(absente.answer);
    await canon.writeCanonicalAssetField({ assetId: poloId, accountId: c.id, key: 'acquisitionDate', value: '2022-09-12', origin: 'USER' });
    await useRecordings([]);
    const presente = await demander(c, "date d'achat polo");
    jamaisMotorisation(presente.answer);
    expect(presente.answer).toContain('12 septembre 2022');
  });

  it('T2-SHORT-AC10 — « date polo » (ambiguë) : aucune caractéristique choisie au hasard', async () => {
    const { c } = await comptePolo();
    await useRecordings([understand({ intent: 'ACCOUNT_FACT_ASSET', confidence: 'ambiguous', entityHints: [{ type: 'asset', value: 'polo' }], requestedFacts: [] })]);
    const r = await demander(c, 'date polo');
    jamaisMotorisation(r.answer);
  });

  it('T2-SHORT-AC06 — « Quelle est la date d’achat de la Polo ? » : déterministe, 0 appel LLM', async () => {
    const { c, poloId } = await comptePolo();
    await canon.writeCanonicalAssetField({ assetId: poloId, accountId: c.id, key: 'acquisitionDate', value: '2022-09-12', origin: 'USER' });
    const replay = await useRecordings([]);
    const r = await demander(c, 'Quelle est la date d’achat de la Polo ?');
    expect(r.answer).toBe('Vous avez acheté Polo le 12 septembre 2022.');
    expect(replay.calls).toHaveLength(0);
  });
});
