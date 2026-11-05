/**
 * Lot 111K — reproduction des DEUX incidents du ticket « T2 : pertinence des
 * preuves » par les VRAIS chemins T2 (`answerFromData` : niveau 1 canonique
 * puis niveau 2 faits T1 ; port de données en mémoire qui applique les mêmes
 * formes de lignes que `account-data.repository`).
 *
 *   I1  montant documentaire demandé (« Combien ai-je payé pour l'entretien
 *       de la Polo ? ») → interprété comme une demande de JUSTIFICATION du
 *       paiement (« aucune preuve de paiement… ne prouve pas qu'il a été
 *       réglé ») ;
 *   I2  information précise demandée (« Quel est le prix de la révision ? »,
 *       « Quelle est la franchise de l'assurance habitation ? ») → plusieurs
 *       valeurs VOISINES présentées comme contradictoires.
 *
 * Écrits AVANT la correction (ils échouaient sur la base `lot110`, voir la
 * recette 111K §2) ; ils restent comme non-régression.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { answerFromData } = await import('../../data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../../sufficiency');
type Port = import('../../data-answer.service').AccountDataPort;
type FactHit = import('../../data-answer.service').FactHit;

const polo = { id: 20, name: 'Polo', category: 'VEHICULE', subtype: null, purchaseDate: null, isRented: false, matched: 1 };
const maison = { id: 30, name: 'Maison', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false, matched: 1 };

let seq = 0;
export function fait(o: Partial<FactHit>): FactHit {
  seq += 1;
  return {
    id: seq, fileId: 100, factKey: 'fact', subject: null, attribute: null, label: null, valueText: null, valueNumber: null, valueUnit: null,
    confidence: 'certain', excerpt: 'extrait', documentTitle: 'Document', matchedTerms: 1, canonicalKey: null, rawKey: null, valueType: null,
    targetType: null, targetEntityId: null, linkedToEntity: false, assetId: null, ...o,
  };
}

function port(over: Partial<Port> = {}): Port {
  const biens = [polo, maison];
  return {
    today: () => '2026-11-05',
    findAssets: async (_a, w) => biens.filter((b) => w.includes(b.name.toLowerCase())),
    listAssets: async () => biens,
    countDocuments: async () => 0,
    countAgenda: async () => 0,
    upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts: async () => [],
    searchDocuments: async () => [],
    ...over,
  };
}

const ask = (message: string, p: Port) => answerFromData({ port: p, accountId: 1, message, thresholds: DEFAULT_THRESHOLDS });

describe('L111K-I1 — montant documentaire ≠ justification du paiement', () => {
  const entretien = {
    theme: 'maintenance' as const,
    byTheme: [{ theme: 'maintenance' as const, label: 'entretien', sumCents: 125000, count: 1, fileIds: [31] }],
    qualifiedSumCents: 125000, qualifiedCount: 1, unqualified: { count: 0, sumCents: 0, fileIds: [], undatedCount: 0 },
    excluded: { count: 0, byType: {} }, duplicates: { count: 0, fileIds: [] }, complete: true,
  };
  const p = port({
    readPayments: async () => ({ proofs: [], sumCents: 0, withoutAmount: 0 }),
    sumQualifiedExpenses: async () => entretien as never,
  });

  it('« Combien ai-je payé pour l’entretien de la Polo ? » : le montant documenté, sans réserve de règlement parasite', async () => {
    const r = await ask('Combien ai-je payé pour l’entretien de la Polo ?', p);
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/1\s250,00\s€/);
    expect(r.answer).not.toMatch(/preuve de paiement|ne prouve pas|règlement n’est pas|réglé/i);
    // Jamais un paiement affirmé sans preuve (CA-07) : la nature reste « documentée ».
    expect(r.answer).not.toMatch(/vous avez (payé|réglé)/i);
    expect(r.strategy).not.toBe('structured.payments');
  });

  it('la question de RÈGLEMENT reste une question de règlement : « L’entretien de la Polo a-t-il été réglé ? »', async () => {
    const r = await ask('L’entretien de la Polo a-t-il été réglé ?', p);
    expect(r.strategy).toBe('structured.payments');
    expect(r.answer).toContain('aucune preuve de paiement');
  });
});

describe('L111K-I2 — information précise ≠ liste de valeurs voisines « contradictoires »', () => {
  it('« Quel est le prix de la révision de la Polo ? » : HT, TTC et main-d’œuvre ne sont pas un conflit ; le prix est le total', async () => {
    const facts = [
      fait({ fileId: 31, subject: 'Révision', label: 'Montant HT', attribute: 'Montant HT', valueNumber: 100, valueUnit: 'EUR', documentTitle: 'Facture révision', assetId: 20 }),
      fait({ fileId: 31, subject: 'Révision', label: 'Montant TTC', attribute: 'Montant TTC', valueNumber: 120, valueUnit: 'EUR', documentTitle: 'Facture révision', assetId: 20 }),
      fait({ fileId: 31, subject: 'Révision', label: 'Main d’œuvre', attribute: 'Main d’œuvre', valueNumber: 60, valueUnit: 'EUR', documentTitle: 'Facture révision', assetId: 20 }),
    ];
    const r = await ask('Quel est le prix de la révision de la Polo ?', port({ searchFacts: async () => facts }));
    expect(r.decision.status).not.toBe('CONFLICTING');
    expect(r.answer ?? '').not.toMatch(/valeurs différentes/);
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/120/);
    expect(r.answer).not.toMatch(/\b100\b|\b60\b/);
  });

  it('« Quelle est la franchise de l’assurance habitation de la maison ? » : la prime et le plafond ne sont ni la réponse ni un conflit', async () => {
    const facts = [
      fait({ fileId: 41, subject: 'Assurance habitation', attribute: 'Prime annuelle', valueNumber: 480, valueUnit: 'EUR', documentTitle: 'Attestation MRH', assetId: 30, matchedTerms: 2 }),
      fait({ fileId: 41, subject: 'Assurance habitation', attribute: 'Franchise', valueNumber: 300, valueUnit: 'EUR', documentTitle: 'Attestation MRH', assetId: 30, matchedTerms: 2 }),
      fait({ fileId: 41, subject: 'Assurance habitation', attribute: 'Plafond mobilier', valueNumber: 20000, valueUnit: 'EUR', documentTitle: 'Attestation MRH', assetId: 30, matchedTerms: 2 }),
    ];
    const r = await ask('Quelle est la franchise de l’assurance habitation de la maison ?', port({ searchFacts: async () => facts }));
    expect(r.decision.status).not.toBe('CONFLICTING');
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/300/);
    expect(r.answer).not.toMatch(/480|20\s?000/);
  });
});
