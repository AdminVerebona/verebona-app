/**
 * Lot 33 — réponses de l'assistant (capture « Adresse de Maison : … Valeur
 * saisie par vous. » + trois boutons « Ouvrir le bien ») :
 *   · ACT-01 : une réponse sur UN bien → UN bouton (dédoublonnage par cible,
 *     pas par identifiant de source : adresse, code postal, ville) ;
 *   · ACT-02 : plusieurs biens → un bouton par bien, « Ouvrir « <nom> » » ;
 *   · TXT-01…04 : plus aucune mention de la source ni de son origine dans
 *     le texte (lecture canonique, entités, multi-faits, faits T1, tableaux) ;
 *     la traçabilité reste dans les sources (interne).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { resolveActions, libelleOuvrirBien } = await import('../action-resolver.service');
const { construireActionIntents } = await import('../ports');
const { routeForIntent } = await import('../intent-router.service');
const { fieldAnswer } = await import('../../canonical/structured-answers');
const { assetFieldSource } = await import('../../canonical/field-reader');
const { readFactsOnTarget } = await import('../fact-reading');

const NOMS: Record<number, string> = { 12: 'Maison', 13: 'Polo', 14: 'Appartement du centre-ville de Caluire-et-Cuire (location)' };
const access = {
  assetInAccount: async (_a: number, id: number) => id in NOMS,
  documentInAccount: async () => true, agendaItemInAccount: async () => true, helpEntryPublished: async () => false,
  assetNames: vi.fn(async (_a: number, ids: number[]) => new Map(ids.filter((i) => i in NOMS).map((i) => [i, NOMS[i]]))),
};
const input = { accountId: 1, userId: 1, planType: 'PREMIUM', message: 'à quelle adresse se situe la maison ?', clientRequestId: 'x', locale: 'fr-FR' };
const src = (id: string, assetId: number) => ({ id, type: 'asset_field', title: 'x', content: '', relevanceScore: 1, meta: { assetId } });
const actionsPour = async (sources: unknown[]) => {
  const route = routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'test');
  return resolveActions({ accountId: 1, intent: 'ACCOUNT_FACT_ASSET', actionIntents: construireActionIntents(route, input as never, sources as never), access });
};

describe('Lot 33 — boutons « Ouvrir le bien »', () => {
  it('ACT-01 — adresse composée (3 champs du même bien) : UN seul bouton « Ouvrir le bien »', async () => {
    const actions = await actionsPour([src('asset_field:12:address1', 12), src('asset_field:12:postalCode', 12), src('asset_field:12:city', 12)]);
    const ouvrir = actions.filter((a) => a.type === 'OPEN_ASSET');
    expect(ouvrir).toHaveLength(1);
    expect(ouvrir[0]).toMatchObject({ label: 'Ouvrir le bien', href: '/assets/12', targetRef: 'asset:12' });
  });

  it('ACT-01b — le bien, une de ses pièces et un de ses équipements : toujours UN bouton pour ce bien', async () => {
    const actions = await actionsPour([
      src('asset_12', 12),
      { id: 'room_4', type: 'asset_field', title: 'Salon', content: '', relevanceScore: 0.8, meta: { assetId: 12 } },
      { id: 'equipment_7', type: 'asset_field', title: 'Chaudière', content: '', relevanceScore: 0.7, meta: { assetId: 12 } },
    ]);
    expect(actions.filter((a) => a.type === 'OPEN_ASSET')).toHaveLength(1);
  });

  it('ACT-02 — plusieurs biens : un bouton par bien, libellé « Ouvrir « <nom du bien> » » (nom lu en base, borné)', async () => {
    const actions = await actionsPour([src('asset_field:12:address1', 12), src('asset_field:13:mileage', 13), src('asset_field:12:city', 12), src('asset_14', 14)]);
    const ouvrir = actions.filter((a) => a.type === 'OPEN_ASSET');
    expect(ouvrir.map((a) => a.label)).toEqual([
      'Ouvrir « Maison »', 'Ouvrir « Polo »', 'Ouvrir « Appartement du centre-ville de Caluire-… »',
    ]);
    expect(ouvrir.map((a) => a.href)).toEqual(['/assets/12', '/assets/13', '/assets/14']);
    expect(access.assetNames).toHaveBeenCalledWith(1, [12, 13, 14]);
    expect(libelleOuvrirBien('  Clio   4 ')).toBe('Ouvrir « Clio 4 »');
  });

  it('ACT-02b — sans lecteur de noms : libellé générique conservé (aucune erreur)', async () => {
    const { assetNames: _n, ...sansNoms } = access;
    const route = routeForIntent('ACCOUNT_FACT_ASSET', 'PREMIUM', 'test');
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_FACT_ASSET', access: sansNoms,
      actionIntents: construireActionIntents(route, input as never, [src('asset_12', 12), src('asset_13', 13)] as never),
    });
    expect(actions.filter((a) => a.type === 'OPEN_ASSET').map((a) => a.label)).toEqual(['Ouvrir le bien', 'Ouvrir le bien']);
  });
});

const lecture = (over: Record<string, unknown> = {}) => ({
  assetId: 12, assetName: 'Maison', key: 'address1', label: 'Adresse', value: '8 impasse de l’Écluse', display: '8 impasse de l’Écluse',
  origin: 'USER', originLabel: 'saisie par vous', updatedAt: '2026-01-02T10:00:00Z', from: 'key', evidence: null, openConflict: null, sensitive: false,
  ...over,
}) as never;

describe('Lot 33 — plus de mention de la source dans le texte', () => {
  it('TXT-01 — lecture canonique : « Adresse de Maison : … » sans « Valeur saisie par vous » ; la source garde l’origine (interne)', () => {
    expect(fieldAnswer(lecture())).toBe('Adresse de Maison : 8 impasse de l’Écluse.');
    const doc = lecture({ origin: 'RECONCILIATION', originLabel: 'retenue après rapprochement de vos documents', evidence: { evidenceId: 1, fileId: 3, documentTitle: 'Acte de vente', documentDate: null, excerpt: 'x', confidence: 'high' } });
    expect(fieldAnswer(doc)).toBe('Adresse de Maison : 8 impasse de l’Écluse.');
    expect(fieldAnswer(doc)).not.toMatch(/Valeur|Acte de vente|rapprochement/);
    // Traçabilité interne inchangée.
    expect(assetFieldSource(doc).content).toContain('origine : retenue après rapprochement de vos documents');
    expect(assetFieldSource(doc).meta).toMatchObject({ origin: 'RECONCILIATION', evidenceFileId: 3 });
  });

  it('TXT-02 — équipements / pièces : valeur sans origine ni titre de document', () => {
    const r = lecture({ value: null, display: null, entities: [{
      target: { type: 'EQUIPMENT', id: 5 }, entityName: 'Chaudière', assetId: 12, key: 'serialNumber', label: 'Numéro de série', value: 'SN-77', display: 'SN-77',
      origin: 'DOCUMENT_EXTRACTION', originLabel: 'lue dans un document', updatedAt: null, from: 'key', sensitive: false,
      evidence: { evidenceId: 1, fileId: 3, documentTitle: 'Facture chaudière', documentDate: null, excerpt: null, confidence: 'high' },
    }] });
    expect(fieldAnswer(r)).toBe('Numéro de série de Chaudière : SN-77.');
  });

  it('TXT-03 — multi-faits (lot 29) : entité et cascade documentaire sans source dans le texte', async () => {
    const readers = {
      field: async () => null,
      entityField: async () => ({
        target: { type: 'EQUIPMENT', id: 5 }, entityName: 'Chaudière', assetId: 12, key: 'serialNumber', label: 'Numéro de série', value: 'SN-77', display: 'SN-77',
        origin: 'USER', originLabel: 'saisie par vous', updatedAt: null, from: 'key', sensitive: false, evidence: null,
      }),
      entitySource: () => ({ id: 'equipment_field:5:serialNumber', type: 'asset_field', title: 't', content: 'origine : saisie par vous', relevanceScore: 1 }),
      assetSource: () => ({ id: 'asset_field:12:x', type: 'asset_field', title: 't', content: '', relevanceScore: 1 }),
      documentSource: () => ({ id: 'doc_3', type: 'document', title: 'Facture', content: '', relevanceScore: 1 }),
      fieldAnswer,
    };
    const r = await readFactsOnTarget(1, { type: 'equipment', id: 5, name: 'Chaudière' } as never, ['serialNumber'], readers as never);
    expect(r.facts[0].text).toBe('Numéro de série de Chaudière : SN-77.');
    expect(r.sources[0].content).toContain('saisie par vous');

    const doc = await readFactsOnTarget(1, { type: 'asset', id: 12, name: 'Polo' } as never, ['mileage'], {
      ...readers,
      field: async () => ({ ...(lecture({ key: 'mileage', label: 'Kilométrage', value: null, display: null, assetName: 'Polo' }) as object) }),
      documentFact: async () => ({ display: '82 000 km', documentTitle: 'Facture entretien VW', fileId: 3 }),
    } as never);
    expect(doc.facts[0].text).toBe('Kilométrage de Polo : 82 000 km (pas encore enregistré sur la fiche).');
    expect(doc.facts[0].text).not.toContain('Facture entretien');
  });
});
