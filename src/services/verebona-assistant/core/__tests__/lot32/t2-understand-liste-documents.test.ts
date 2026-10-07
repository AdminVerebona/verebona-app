/**
 * Lot 32 — test I, chemin de PRODUCTION (niveau 1 de `answerFromData`) :
 * « Quels documents sont liés à la Polo ? » est la LISTE des documents du
 * bien, recherchée sur ce bien seul ; zéro document → « aucun document »
 * nommant le bien (jamais « rien trouvé » à l'échelle du compte).
 */
import { describe, it, expect } from 'vitest';
import { answerFromData, type AccountDataPort, type AssetRow } from '../../data-answer.service';
import { DEFAULT_THRESHOLDS } from '../../sufficiency';

const POLO: AssetRow = { id: 20, name: 'Polo', category: 'VEHICULE', subtype: 'Voiture', purchaseDate: null, isRented: false };
const CUPRA: AssetRow = { id: 21, name: 'Cupra', category: 'VEHICULE', subtype: 'Voiture', purchaseDate: null, isRented: false };

function port(docs: Record<number, Array<{ fileId: number; title: string }>>) {
  const appels: number[][] = [];
  const p: AccountDataPort = {
    today: () => '2026-10-07',
    async findAssets(_a, mots) { return [POLO, CUPRA].filter((a) => mots.includes(a.name.toLowerCase())).map((a) => ({ ...a, matched: 1 })); },
    async listAssets() { return [POLO, CUPRA]; },
    async countDocuments() { return 0; },
    async countAgenda() { return 0; },
    async upcomingAgenda() { return []; },
    async sumDocumentAmounts() { return { sumCents: 0, count: 0 }; },
    async searchFacts() { return []; },
    async searchDocuments() { return []; },
    async listDocuments(_a, o) {
      appels.push(o.assetIds);
      return (docs[o.assetIds[0]] ?? []).map((d) => ({ ...d, date: null, assetName: null, matchedTerms: 1 }));
    },
  };
  return { p, appels };
}

describe('Lot 32 — liste des documents d’un bien (chemin SQL)', () => {
  it('T2U-I-SQL — « Quels documents sont liés à la Polo ? », zéro document : recherche sur la Polo, réponse « aucun document »', async () => {
    const { p, appels } = port({});
    const r = await answerFromData({ port: p, accountId: 1, message: 'Quels documents sont liés à la Polo ?', thresholds: DEFAULT_THRESHOLDS, intent: 'ACCOUNT_SEARCH_DOCUMENT' });
    expect(appels).toEqual([[20]]);
    expect(r.handled).toBe(true);
    expect(r.strategy).toBe('structured.list_documents');
    expect(r.answer).toMatch(/aucun document pour Polo/);
  });

  it('T2U-G-SQL — bien du fil (« lui ») : liste de SES documents', async () => {
    const { p, appels } = port({ 21: [{ fileId: 9, title: 'Assurance Cupra' }] });
    const r = await answerFromData({ port: p, accountId: 1, message: 'Quels documents lui sont liés ?', resolvedAssetId: 21, thresholds: DEFAULT_THRESHOLDS, intent: 'ACCOUNT_SEARCH_DOCUMENT' });
    expect(appels).toEqual([[21]]);
    expect(r.answer).toMatch(/Assurance Cupra/);
  });

  it('T2U-F-SQL — « Quels documents ai-je ? » : aucune liste par bien (recherche globale servie plus loin)', async () => {
    const { p, appels } = port({});
    await answerFromData({ port: p, accountId: 1, message: 'Quels documents ai-je ?', thresholds: DEFAULT_THRESHOLDS, intent: 'ACCOUNT_SEARCH_DOCUMENT' });
    expect(appels).toEqual([]);
  });
});
