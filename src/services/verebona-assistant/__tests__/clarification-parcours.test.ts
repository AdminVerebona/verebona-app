/**
 * Parcours de clarification complet — CDC §20.
 *
 * ambiguïté détectée → clarification créée → état initial conservé → choix
 * sécurisé → reprise structurée de la demande → repli après deux échecs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assetCandidates,
  buildAssetClarification,
  interpretTypedAnswer,
  isExpired,
  clarificationSignature,
  isClarificationCycle,
  MAX_FAILED_ATTEMPTS,
} from '@/services/verebona-assistant/core/clarification-builder';
import { verifierClarification, inputDeReprise } from '@/services/verebona-assistant/core/clarification.service';
import { answerFromData, type AccountDataPort, type AssetRow } from '@/services/verebona-assistant/core/data-answer.service';
import { routeDeterministic } from '@/services/verebona-assistant/core/intent-router.service';
import { DEFAULT_THRESHOLDS } from '@/services/verebona-assistant/core/sufficiency';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const MAISONS: AssetRow[] = [
  { id: 42, name: 'Maison', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false, city: 'Lyon', address: '12 rue Victor Hugo' },
  { id: 87, name: 'Maison', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false, city: 'Annecy', address: '4 avenue du Lac' },
];

const port: AccountDataPort = {
  today: () => '2026-09-25',
  async findAssets() { return MAISONS.map((a) => ({ ...a, matched: 1 })); },
  async listAssets() { return MAISONS; },
  async countDocuments(_a, o = {}) { return o.assetIds?.includes(42) ? 2 : 1; },
  async countAgenda() { return 0; },
  async upcomingAgenda() { return [{ id: 1, title: 'Ramonage', date: '2026-10-10', assetNames: ['Maison'] }]; },
  async sumDocumentAmounts() { return { sumCents: 0, count: 0 }; },
  async searchFacts() { return []; },
  async searchDocuments() { return []; },
  async listDocuments(_a, o) {
    return o.assetIds[0] === 42
      ? [{ fileId: 1, title: 'Facture chaudière', date: '2026-03-01', assetName: 'Maison', matchedTerms: 1 }]
      : [{ fileId: 2, title: 'Acte de vente', date: '2025-01-10', assetName: 'Maison', matchedTerms: 1 }];
  },
};

const etat = () => buildAssetClarification({
  assets: MAISONS, reason: 'LIST_DOCUMENTS_MULTIPLE_ASSETS', accountId: 1, userId: 2, conversationId: 3,
  originalMessage: 'Montre-moi les documents de ma maison', originalMessageId: 'm1',
  originalIntent: 'ACCOUNT_SEARCH_DOCUMENT', chainDepth: 1, now: new Date('2026-09-25T10:00:00Z'),
});

describe('détection de l’ambiguïté', () => {
  it('deux biens également plausibles : aucun choix arbitraire', async () => {
    const r = await answerFromData({ port, accountId: 1, message: 'Montre-moi les documents de ma maison', thresholds: DEFAULT_THRESHOLDS });
    expect(r.handled).toBe(false);
    expect(r.ambiguity?.candidates.map((a) => a.id)).toEqual([42, 87]);
  });

  it('prochaine échéance « de ma maison » avec deux maisons : clarification', async () => {
    const r = await answerFromData({ port, accountId: 1, message: 'Quelle est la prochaine échéance de ma maison ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.ambiguity?.reason).toBe('NEXT_DEADLINE_MULTIPLE_ASSETS');
  });

  it('un comptage se détaille par bien : pas de clarification (réponse déterministe possible)', async () => {
    const r = await answerFromData({ port, accountId: 1, message: 'Combien de documents pour ma maison ?', thresholds: DEFAULT_THRESHOLDS });
    expect(r.ambiguity).toBeUndefined();
    expect(r.answer).toMatch(/Maison \(Lyon\) : 2/);
  });

  it('bien fixé par la clarification : la demande initiale aboutit', async () => {
    const r = await answerFromData({ port, accountId: 1, message: 'Montre-moi les documents de ma maison', resolvedAssetId: 42, thresholds: DEFAULT_THRESHOLDS });
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/Facture chaudière/);
    expect(r.answer).not.toMatch(/Acte de vente/);
  });

  it('bien fixé mais disparu : aucune réponse sur un objet invalide', async () => {
    const r = await answerFromData({ port, accountId: 1, message: 'Montre-moi les documents de ma maison', resolvedAssetId: 999, thresholds: DEFAULT_THRESHOLDS });
    expect(r.handled).toBe(false);
    expect(r.ambiguity).toBeUndefined();
  });

  it('« montre-moi les documents de ma maison » est une question de données, pas une navigation', () => {
    const o = routeDeterministic({ message: 'Montre-moi les documents de ma maison', planType: 'PREMIUM', hasPendingClarification: false });
    expect(o.kind === 'route' && o.route.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
  });
});

describe('état persisté et candidats', () => {
  it('tout ce qu’il faut pour reprendre', () => {
    const e = etat();
    expect(e).toMatchObject({
      conversationId: 3, accountId: 1, userId: 2,
      originalMessage: 'Montre-moi les documents de ma maison',
      originalIntent: 'ACCOUNT_SEARCH_DOCUMENT',
      ambiguity: { kind: 'asset', field: 'assetId' },
      question: 'De quel bien parlez-vous ?',
      attemptCount: 0, chainDepth: 1, status: 'PENDING',
    });
    expect(new Date(e.expiresAt).getTime() - new Date(e.createdAt!).getTime()).toBe(30 * 60_000);
  });

  it('candidats explicites, identifiants produits par le serveur', () => {
    const c = etat().candidates;
    expect(c).toEqual([
      { id: 'asset_42', entityId: 42, label: 'Maison', secondaryLabel: 'Lyon, 12 rue Victor Hugo' },
      { id: 'asset_87', entityId: 87, label: 'Maison', secondaryLabel: 'Annecy, 4 avenue du Lac' },
    ]);
  });

  it('deux candidats indiscernables reçoivent un rang', () => {
    const c = assetCandidates([{ ...MAISONS[0], city: null, address: null }, { ...MAISONS[1], city: null, address: null }]);
    expect(c[0].secondaryLabel).not.toBe(c[1].secondaryLabel);
  });
});

describe('choix sécurisé', () => {
  it('identifiant inventé refusé', () => {
    const e = etat();
    expect(verifierClarification(e, e.clarificationId, 'asset_999', new Date('2026-09-25T10:05:00Z'))).toEqual({ ok: false, motif: 'CHOIX_INVALIDE' });
  });

  it('clarification expirée refusée', () => {
    const e = etat();
    expect(isExpired(e, new Date('2026-09-25T10:31:00Z'))).toBe(true);
    expect(verifierClarification(e, e.clarificationId, 'asset_42', new Date('2026-09-25T10:31:00Z'))).toEqual({ ok: false, motif: 'EXPIREE' });
  });

  it('clarification déjà résolue : un ancien bouton ne la réactive pas', () => {
    const e = { ...etat(), status: 'RESOLVED' as const };
    expect(verifierClarification(e, e.clarificationId, 'asset_42', new Date('2026-09-25T10:05:00Z')).ok).toBe(false);
  });

  // Lot 114A (#753, CDC T2 D02 / M07) — règle remplacée : « deux clarifications
  // successives au plus ». Le plafond des RÉPONSES INVALIDES reste ; la série
  // de questions n'est plus bornée que par la détection de boucle.
  it('deux échecs au plus ; plus de plafond de clarifications, mais jamais deux fois la même question', () => {
    expect(MAX_FAILED_ATTEMPTS).toBe(2);
    const e = etat();
    expect(isClarificationCycle(e, null)).toBe(false);
    expect(isClarificationCycle(e, { asked: ['asset|asset|1,2'] })).toBe(false);
    expect(isClarificationCycle(e, { asked: [clarificationSignature(e)] })).toBe(true);
  });
});

describe('réponse tapée', () => {
  it.each([
    ['la première', 42], ['2', 87], ['Annecy', 87], ['celle de Lyon', 42],
  ])('« %s » désigne le bon candidat', (texte, id) => {
    const r = interpretTypedAnswer(etat(), texte);
    expect(r.kind === 'match' && r.candidate.entityId).toBe(id);
  });

  it('réponse qui ne désigne rien : tentative infructueuse', () => {
    expect(interpretTypedAnswer(etat(), 'euh').kind).toBe('no_match');
    // « Maison » seul désigne les deux : toujours ambigu.
    expect(interpretTypedAnswer(etat(), 'Maison').kind).toBe('no_match');
  });

  it('nouvelle question : clarification abandonnée, question traitée normalement', () => {
    expect(interpretTypedAnswer(etat(), 'Quand expire mon assurance auto ?').kind).toBe('new_question');
  });
});

describe('reprise structurée', () => {
  it('demande initiale + choix injecté, jamais une concaténation', () => {
    const e = etat();
    const input = inputDeReprise({ accountId: 1, userId: 2, planType: 'PREMIUM', locale: 'fr-FR' }, e, e.candidates[0]);
    expect(input.message).toBe('Montre-moi les documents de ma maison');
    expect(input.message).not.toContain(e.question);
    expect(input.conversationId).toBe(3);
    expect(input.resume).toMatchObject({ intent: 'ACCOUNT_SEARCH_DOCUMENT', assetId: 42, chainDepth: 1 });
    // Lot 114A : le choix est conservé comme décision, la question comme déjà posée.
    expect(input.resume?.decisions).toMatchObject({ assetId: 42 });
    expect(input.resume?.asked).toEqual([clarificationSignature(e)]);
  });

  it('l’orchestrateur garde l’intention initiale et crée la clarification sur le fil', () => {
    const o = read('src/services/verebona-assistant/core/assistant-orchestrator.service.ts');
    expect(o).toMatch(/routeForIntent\(input\.resume\.intent/);
    expect(o).toMatch(/ports\.saveClarification\(state\)/);
    expect(o).not.toMatch(/MAX_CLARIFICATION_CHAIN/);
    expect(o).toMatch(/isClarificationCycle\(state, input\.resume\)/);
    expect(o).not.toMatch(/`\$\{etat!?\.question\} \$\{verdict\.choix\.label\}`/);
  });

  it('la route de réponse ne recolle plus question + libellé', () => {
    const r = read('src/app/api/verebona/clarifications/[clarificationId]/answer/route.ts');
    expect(r).not.toMatch(/etat!\.question/);
    expect(r).toMatch(/resoudreClarification\(/);
  });

  it('le candidat est re-vérifié en base avant reprise', () => {
    const s = read('src/services/verebona-assistant/core/clarification.service.ts');
    expect(s).toMatch(/candidatToujoursValide\(p\.accountId, e\.candidateType, candidate\)/);
    // Lot 29 (ticket 14) : règle de disponibilité UNIQUE (`asset-availability`).
    expect(s).toMatch(/assistantAssetAvailability\.sql\('a'\)/);
  });

  it('chaque étape est tracée', () => {
    const s = read('src/services/verebona-assistant/core/clarification.service.ts');
    for (const evt of ['CREATED', 'CHOICE_ACCEPTED', 'INVALID_CHOICE', 'UNRECOGNIZED_ANSWER', 'EXPIRED', 'CANDIDATE_UNAVAILABLE', 'FALLBACK', 'ABANDONED']) {
      expect(s).toContain(`'${evt}'`);
    }
    expect(read('src/services/verebona-assistant/core/clarification-flow.ts')).toMatch(/'RESUME_FAILED' : 'RESUME_SUCCEEDED'/);
  });
});
