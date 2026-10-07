/**
 * Lot 29 — ticket 14 : biens ARCHIVED / TRANSMIS exclus de TOUTES les
 * résolutions de cible de T2 (règle unique `asset-availability`).
 *
 * Sans base : résolution réelle (`resolveAssistantTargets`), orchestrateur
 * réel, lectures injectées appliquant la règle unique ; les requêtes SQL
 * (findAssets, listAssets, revalidation de clarification, références du fil,
 * commandes, catalogue des cibles) sont capturées pour vérifier qu'elles
 * portent TOUTES la même condition. Le comportement sur PostgreSQL réel est
 * couvert par `src/test/e2e/scenarios/l29-t2-lecture-donnees.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const unsafe = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, params?: unknown[]) => unsafe(sql, params) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('./harness');
const { resolveAssistantTargets } = await import('../../assistant-targets');
const avail = await import('../../asset-availability');
const { candidatToujoursValide } = await import('../../clarification.service');
const { listAvailableAssets, findEntitiesByTerms, findEntityById, findVehiclesByIdentifier } = await import('../../target-lookup.repository');
const { accountDataRepository } = await import('../../account-data.repository');

const REGLE = avail.assistantAssetAvailability.sql('a');
beforeEach(() => unsafe.mockClear());

const polo = (id: number, status: string | null, mileage: number) => ({ id, name: 'Polo', category: 'VEHICULE', status, fields: { mileage } });

describe('Ticket 14 — disponibilité des biens pour T2', () => {
  it('T2ARCH-AC01 — Polo EN_SERVICE + Polo ARCHIVED : la Polo active est lue directement, sans clarification', async () => {
    const h = H.harness(H.account({ assets: [polo(1, 'EN_SERVICE', 82000), polo(2, 'ARCHIVED', 150000)] }));
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toContain('82');
    expect(r.answer).not.toContain('150');
    expect(h.readers.calls.every((c) => c.id !== 2)).toBe(true);
    expect(h.llmCalls()).toBe(0);
  });

  it('T2ARCH-AC02 — Polo EN_SERVICE + Polo TRANSMIS : le bien transmis n’est pas candidat', async () => {
    const h = H.harness(H.account({ assets: [polo(1, 'EN_SERVICE', 82000), polo(2, 'TRANSMIS', 150000)] }));
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toContain('82');
    expect(h.readers.calls.every((c) => c.id !== 2)).toBe(true);
  });

  it('T2ARCH-AC03 — uniquement une Polo ARCHIVED : aucun bien actif correspondant, aucune lecture silencieuse', async () => {
    const h = H.harness(H.account({ assets: [polo(2, 'ARCHIVED', 150000)] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['mileage'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.answer).not.toContain('150');
    expect(r.answer).toMatch(/pas identifié le bien « Polo »/);
    expect(r.cascade?.diagnostic).toBe('TARGET_NOT_FOUND');
    expect(h.readers.calls).toEqual([]);
  });

  it('T2ARCH-AC04 — uniquement une Polo TRANSMIS : même comportement', async () => {
    const h = H.harness(H.account({ assets: [polo(2, 'TRANSMIS', 150000)] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['mileage'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.answer).not.toContain('150');
    expect(r.cascade?.diagnostic).toBe('TARGET_NOT_FOUND');
    expect(h.readers.calls).toEqual([]);
  });

  it('T2ARCH-AC05 — deux biens actifs : clarification normale avec les deux', async () => {
    const h = H.harness(H.account({ assets: [
      { id: 1, name: 'Polo perso', category: 'VEHICULE', status: 'EN_SERVICE' }, { id: 3, name: 'Polo conjoint', category: 'VEHICULE', status: 'EN_SERVICE' },
    ] }));
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.clarification?.candidates.map((c) => c.entityId)).toEqual([1, 3]);
    expect(h.readers.calls).toEqual([]);
  });

  it('T2ARCH-AC06 — deux actifs + un archivé : la clarification ne présente que les deux actifs', async () => {
    const h = H.harness(H.account({ assets: [
      { id: 1, name: 'Polo perso', category: 'VEHICULE' }, { id: 3, name: 'Polo conjoint', category: 'VEHICULE', status: 'EN_PANNE' },
      { id: 4, name: 'Polo ancienne', category: 'VEHICULE', status: 'ARCHIVED' },
    ] }));
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r.clarification?.candidates.map((c) => c.entityId).sort()).toEqual([1, 3]);
  });

  it('T2ARCH-AC07 — recherche par catégorie : Maison A EN_SERVICE + Maison B ARCHIVED → Maison A directe', async () => {
    const h = H.harness(H.account({ assets: [
      { id: 10, name: 'Maison A', category: 'IMMOBILIER', subtype: 'Maison', fields: { address1: '1 rue Active' } },
      { id: 11, name: 'Maison B', category: 'IMMOBILIER', subtype: 'Maison', status: 'ARCHIVED', fields: { address1: '9 rue Archivée' } },
    ] }));
    const r = await h.ask('Quelle est l’adresse de ma maison ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toContain('1 rue Active');
    expect(r.answer).not.toContain('Archivée');
  });

  it('T2ARCH-AC08 — indice UNDERSTAND « Maison » : aucun candidat ARCHIVED / TRANSMIS transmis à la résolution', async () => {
    const acc = H.account({ assets: [
      { id: 10, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' },
      { id: 11, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', status: 'ARCHIVED' },
      { id: 12, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', status: 'TRANSMIS' },
    ] });
    const lookup = H.fakeLookup(acc);
    const t = await resolveAssistantTargets({ accountId: 1, message: 'et l’adresse ?' }, { entityHints: [{ type: 'asset', value: 'Maison' }] }, lookup, { requestedFacts: ['address1'] });
    expect(t.catalog?.map((c) => c.id)).toEqual([10]);
    expect(t.asset).toMatchObject({ id: 10 });
    expect(t.ambiguity ?? null).toBeNull();
    // Le catalogue SQL porte la règle AVANT tout classement.
    await listAvailableAssets(1);
    expect(String(unsafe.mock.calls[0][0])).toContain(REGLE);
  });

  it('T2ARCH-AC09 — contexte de page devenu invalide : rejeté, aucune lecture canonique', async () => {
    const h = H.harness(H.account({ assets: [polo(42, 'ARCHIVED', 150000)] }));
    const r = await h.ask('Quel est son kilométrage ?', { pageContext: { assetId: '42', route: '/assets/42' } });
    expect(r.answer).toMatch(/n’est plus disponible dans vos biens actifs/);
    expect(r.answer).not.toMatch(/rien trouvé/);
    expect(r.cascade?.diagnostic).toBe('TARGET_UNAVAILABLE');
    expect(h.readers.calls).toEqual([]);
  });

  it('T2ARCH-AC10 — référence du fil devenue invalide : détectée, jamais « rien trouvé »', async () => {
    const h = H.harness(H.account({ assets: [polo(42, 'ARCHIVED', 150000)] }), { thread: H.threadOn('asset', 42, 'Polo') });
    const r = await h.ask('Et son kilométrage ?');
    expect(r.answer).toBe(avail.ASSET_NO_LONGER_AVAILABLE_MESSAGE);
    expect(r.cascade?.reference?.outcome).toBe('unavailable');
    expect(h.readers.calls).toEqual([]);
  });

  it('T2ARCH-AC11 — clarification devenue invalide : le candidat archivé est rejeté par la revalidation (règle unique)', async () => {
    unsafe.mockResolvedValueOnce([]);
    expect(await candidatToujoursValide(1, 'asset', { id: 'asset_2', entityId: 2, label: 'Polo' })).toBe(false);
    expect(String(unsafe.mock.calls[0][0])).toContain(REGLE);
    unsafe.mockResolvedValueOnce([{ '?column?': 1 }]);
    expect(await candidatToujoursValide(1, 'asset', { id: 'asset_1', entityId: 1, label: 'Polo' })).toBe(true);
  });

  it('T2ARCH-AC12 — findAssets() : la règle est dans la requête, avant le classement', async () => {
    await accountDataRepository.findAssets(1, ['polo']).catch(() => []);
    const sql = String(unsafe.mock.calls.find((c) => String(c[0]).includes('matched'))?.[0] ?? '');
    // La condition est dans la sous-requête (WHERE du bien), pas un filtre a posteriori.
    expect(sql).toMatch(new RegExp(`WHERE a\\.account_id = \\$1 AND ${REGLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*\\) s WHERE s\\.matched > 0`));
    // Statuts : EN_SERVICE / EN_PANNE retournés, ARCHIVED / TRANSMIS / supprimé absents.
    expect(avail.isAssetAvailableForAssistant({ status: 'EN_SERVICE' })).toBe(true);
    expect(avail.isAssetAvailableForAssistant({ status: 'EN_PANNE' })).toBe(true);
    expect(avail.isAssetAvailableForAssistant({ status: 'ARCHIVED' })).toBe(false);
    expect(avail.isAssetAvailableForAssistant({ status: 'TRANSMIS' })).toBe(false);
    expect(avail.isAssetAvailableForAssistant({ status: 'EN_SERVICE', deletedAt: new Date() })).toBe(false);
  });

  it('T2ARCH-AC13 — listAssets() et findAssets() appliquent EXACTEMENT la même règle (cohérence inter-parcours)', async () => {
    await accountDataRepository.findAssets(1, ['polo']).catch(() => []);
    await accountDataRepository.listAssets(1).catch(() => []);
    const sqls = unsafe.mock.calls.map((c) => String(c[0])).filter((s) => /FROM assets a/.test(s) && !/row_to_json/.test(s));
    expect(sqls.length).toBeGreaterThanOrEqual(2);
    for (const s of sqls) expect(s).toContain(REGLE);
    // Mêmes requêtes pour le catalogue des cibles, les entités, les véhicules.
    unsafe.mockClear();
    await listAvailableAssets(1);
    await findEntitiesByTerms(1, 'equipment', ['chaudiere']);
    await findEntitiesByTerms(1, 'room', ['cuisine']);
    await findEntityById(1, 'equipment', 3);
    await findVehiclesByIdentifier(1, { plates: ['AB123CD'], vins: [] });
    expect(unsafe.mock.calls).toHaveLength(5);
    for (const c of unsafe.mock.calls) expect(String(c[0])).toContain(REGLE);
  });

  it('T2ARCH-AC14 — non-régression : EN_PANNE, EN_REPARATION, INACTIF (et autres statuts) restent accessibles', async () => {
    // Lot 32 (PO-Q11) : VENDU rejoint ARCHIVED / TRANSMIS (voir PO-Q11 dans
    // l32f-statuts-bien.test.ts) ; les anciennes valeurs restent lisibles.
    for (const st of ['EN_PANNE', 'EN_REPARATION', 'INACTIF', 'EN_MAINTENANCE', 'HORS_SERVICE', 'DETRUIT', null]) {
      expect(avail.isAssetAvailableForAssistant({ status: st })).toBe(true);
    }
    const h = H.harness(H.account({ assets: [{ id: 5, name: 'Clio', category: 'VEHICULE', status: 'EN_REPARATION', fields: { mileage: 12000 } }] }));
    const r = await h.ask('Quel est le kilométrage de la Clio ?');
    expect(r.answer).toContain('12');
    expect(avail.ASSISTANT_EXCLUDED_ASSET_STATUSES).toEqual(['ARCHIVED', 'TRANSMIS', 'VENDU']);
  });

  it('T2ARCH-G — règle centralisée : aucune autre copie de la condition dans le code T2', () => {
    const racine = join(process.cwd(), 'src/services/verebona-assistant');
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__') parcourir(p); } else if (n.endsWith('.ts')) fichiers.push(p);
      }
    };
    parcourir(racine);
    const copies = fichiers.filter((f) => !f.endsWith('asset-availability.ts')
      && /NOT IN \(\s*'ARCHIVED'|\['ARCHIVED', 'TRANSMIS'\]/.test(readFileSync(f, 'utf8')));
    expect(copies).toEqual([]);
    // Et les parcours listés par le ticket s'appuient sur elle.
    for (const f of ['core/account-data.repository.ts', 'core/clarification.service.ts', 'core/ports.ts', 'core/target-lookup.repository.ts',
      'commands/plan.service.ts', 'canonical/completeness.ts', 'registries/retrieval-adapters.ts', 'core/retrieval.service.ts']) {
      expect(readFileSync(join(racine, f), 'utf8')).toMatch(/assistantAsset(Availability|StatusCondition)/);
    }
  });
});
