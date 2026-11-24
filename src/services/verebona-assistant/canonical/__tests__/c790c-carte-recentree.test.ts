/**
 * Carte #790 RECENTRÉE par le PO le 22/11/2026 — « Corriger le rendu structuré des réponses (code déterministe
 * et IA) ». Complément du 24/11 : ce que le premier correctif (116-15) laissait ouvert.
 *
 *   C790C-IA   §2.B — les frontières entre affirmations (`claims`) du modèle sont conservées : une affirmation par
 *              paragraphe dès qu'il y en a plusieurs ; une seule, ou des lignes qui forment une même phrase : un
 *              paragraphe ; rien n'est forcé (ni titre, ni liste, ni chiffre clé) ; sources et contrôle inchangés ;
 *   C790C-CTL  validation et contrôle final : mêmes verdicts, frontières conservées à la reconstruction ;
 *   C790C-TCO  §2.A / §3 — toutes les variantes du coût de possession citées par la carte ;
 *   C790C-CMP  §1 — assemblages composites qui écrasaient une frontière ;
 *   C790C-HIS  §4.3 — ancien historique : une ancienne réponse monobloc ne plante pas et n'est pas réinterprétée ;
 *   C790C-DUR  §3 — aucun montant de l'exemple Polo en dur hors des tests.
 *
 * Aucun appel à un fournisseur d'IA : les sorties du modèle sont des objets du contrat `T2AnswerOutput`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerBlock } from '@/lib/verebona/answer-blocks';
import type { TcoResult } from '@/services/business-operations/tco/model';
import type { CasProduit } from './fixtures/c790b-cas';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) }, db: {},
  ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const { answerBlocksFor, answerBlocksText, buildAnswerBlocks, isPlainAnswer, parseAnswerBlocks } = await import('@/lib/verebona/answer-blocks');
const { continuesSentence, joinAnswerLines } = await import('@/lib/verebona/answer-compose');
const { answerBlocksForApi } = await import('../../core/api-payload');
const { toGeneratedAnswer } = await import('../../core/generation.adapter');
const { controlFinalAnswer } = await import('../../core/final-answer-control');
const { validateGeneratedAnswer, countSentences } = await import('../../core/response-validator.service');
const { analyzeScope } = await import('../../core/blocked-topics');
const { answerFromData } = await import('../../core/data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../../core/sufficiency');
const { t2AnswerLines } = await import('@/services/ai/assistant/master/t2-answer');
const { T2AnswerOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { fieldAnswer, ownershipCostAnswer, ownershipCostLockedAnswer } = await import('../structured-answers');
const { POLO, POLO_MONTANTS, poloTco } = await import('./fixtures/c790b-polo');

type Port = import('../../core/data-answer.service').AccountDataPort;
type Reading = import('../field-reader').CanonicalFieldReading;

const AVANT = JSON.parse(readFileSync(join(__dirname, 'fixtures/c790b-avant-correctif.json'), 'utf8')) as Record<string, CasProduit>;

const nb = (s: string) => s.replace(/[  ]/g, ' ');
const serre = (s: string) => s.replace(/\s+/g, ' ').trim();
const nombres = (s: string) => (nb(s).match(/\d+(?: \d{3})*(?:,\d+)?/g) ?? []).sort();
const formes = (answer: string) => buildAnswerBlocks(answer).map((b) => b.kind);
const texteDe = (b: AnswerBlock) => answerBlocksText([b]);

const SOURCES = [
  { id: 'asset_field:7:mileage', content: 'Kilométrage : 82 000 km' },
  { id: 'agenda:12', content: 'Contrôle technique le 12/03/2027' },
  { id: 'doc:31', content: 'Facture Garage Martin : vidange 189,90 € le 04/02/2026' },
];
const SRC = SOURCES.map((s) => ({ id: s.id, type: 'document' as const, title: s.id, content: s.content, relevanceScore: 1, meta: {} }));

/** Sortie du modèle au contrat ANSWER réel (schéma de production), puis assemblage de production. */
function reponseIa(sortie: unknown) {
  const data = T2AnswerOutput.parse(sortie);
  const l = t2AnswerLines(data);
  const supportEvents: string[] = [];
  const out = toGeneratedAnswer(
    { claims: l.lines, status: l.status, actionIntents: [], derivations: [] }, SRC, [],
    { verifySupport: true, supportEvents, separator: l.separator },
  );
  if (!out) throw new Error('sortie du modèle rejetée');
  return { ...out, separator: l.separator, supportEvents };
}
const claims = (...c: Array<[string, string[]] | [string, string[], false]>) => ({
  mode: 'ANSWER', format: 'claims', status: 'answered',
  claims: c.map(([text, sourceIds, factual]) => ({ text, sourceIds, ...(factual === false ? { factual: false } : {}) })),
});

const KM = 'Le kilométrage de la Clio est de 82 000 km.';
const CT = 'Son contrôle technique est prévu le 12/03/2027.';
const VIDANGE = 'La dernière vidange a coûté 189,90 €.';

describe('C790C-IA — §2.B : les frontières entre affirmations du modèle arrivent au rendu', () => {
  it('`t2AnswerLines` : le format `claims` ne déclare plus une espace ; `comparison` et `timeline` : une ligne par élément', () => {
    const c = t2AnswerLines(T2AnswerOutput.parse(claims([KM, ['asset_field:7:mileage']], [CT, ['agenda:12']])));
    expect(c.separator).toBe('\n\n');
    expect(c.lines.map((l) => [l.text, l.sourceIds])).toEqual([[KM, ['asset_field:7:mileage']], [CT, ['agenda:12']]]);
    const t = t2AnswerLines(T2AnswerOutput.parse({ mode: 'ANSWER', format: 'timeline', status: 'answered', events: [{ date: '2026-02-04', text: 'Vidange', sourceIds: ['doc:31'] }] }));
    expect(t.separator).toBe('\n');
    const k = t2AnswerLines(T2AnswerOutput.parse({ mode: 'ANSWER', format: 'comparison', status: 'answered', criterion: 'kilométrage', items: [{ targetId: 'asset:7', label: 'Clio', value: '82 000 km', sourceIds: ['asset_field:7:mileage'] }] }));
    expect(k.separator).toBe('\n');
  });

  it('recette §4 point 2 : deux affirmations distinctes ne sont PAS concaténées en un seul bloc', () => {
    const ia = reponseIa(claims([KM, ['asset_field:7:mileage']], [CT, ['agenda:12']]));
    expect(ia.answer).toBe(`${KM}\n\n${CT}`);
    const blocs = buildAnswerBlocks(ia.answer);
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
    expect(blocs.map(texteDe)).toEqual([KM, CT]);
    // Chaque paragraphe est exactement UNE affirmation vérifiée, avec SES sources.
    expect(ia.claims.map((c) => [c.claimKey, c.text, c.sourceIds])).toEqual([
      ['c1', KM, ['asset_field:7:mileage']], ['c2', CT, ['agenda:12']],
    ]);
    expect(ia.supportLevel).toBe('supported');
    // Ce que l'API transmet = ce que l'écran recalcule (première réponse, historique, rejeu).
    expect(answerBlocksForApi(ia.answer)).toEqual(blocs);
    expect(answerBlocksFor(ia.answer, answerBlocksForApi(ia.answer))).toEqual(blocs);
    expect(answerBlocksFor(ia.answer, undefined)).toEqual(blocs);
  });

  it('trois affirmations : trois paragraphes, dans l’ordre du modèle ; aucun mot, chiffre ni date ajouté ou perdu', () => {
    const ia = reponseIa(claims([KM, ['asset_field:7:mileage']], [CT, ['agenda:12']], [VIDANGE, ['doc:31']]));
    expect(formes(ia.answer)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(serre(ia.answer)).toBe([KM, CT, VIDANGE].join(' '));
    expect(serre(answerBlocksText(buildAnswerBlocks(ia.answer)))).toBe([KM, CT, VIDANGE].join(' '));
    expect(nombres(ia.answer)).toEqual(nombres([KM, CT, VIDANGE].join(' ')));
  });

  it('réponse simple : UNE affirmation reste une phrase — ni titre, ni liste, ni chiffre clé, aucun bloc transmis', () => {
    const ia = reponseIa(claims([KM, ['asset_field:7:mileage']]));
    expect(ia.answer).toBe(KM);
    expect(isPlainAnswer(buildAnswerBlocks(ia.answer))).toBe(true);
    expect(answerBlocksForApi(ia.answer)).toBeNull();
  });

  it('rien n’est forcé : des phrases ordinaires ne deviennent jamais titre, liste, tableau ou chiffre clé', () => {
    const ia = reponseIa(claims([KM, ['asset_field:7:mileage']], [CT, ['agenda:12']], [VIDANGE, ['doc:31']]));
    expect(new Set(formes(ia.answer))).toEqual(new Set(['paragraph']));
    expect(ia.answer).not.toMatch(/Chiffre clé|^#|^•|^\|/m);
  });

  it('des lignes qui forment ensemble UNE phrase restent un paragraphe (fragment sans point final, ou suite en minuscule)', () => {
    const fragment = reponseIa(claims(['La Clio a 82 000 km', ['asset_field:7:mileage']], ['et son contrôle technique est prévu le 12/03/2027.', ['agenda:12']]));
    expect(fragment.answer).toBe('La Clio a 82 000 km et son contrôle technique est prévu le 12/03/2027.');
    expect(formes(fragment.answer)).toEqual(['paragraph']);
    const suite = reponseIa(claims([KM, ['asset_field:7:mileage']], ['mais son contrôle technique est prévu le 12/03/2027.', ['agenda:12']]));
    expect(formes(suite.answer)).toEqual(['paragraph']);
    // Les deux affirmations restent vérifiées séparément.
    expect(fragment.claims.map((c) => c.sourceIds)).toEqual([['asset_field:7:mileage'], ['agenda:12']]);
  });

  it('`continuesSentence` : la règle, cas par cas', () => {
    expect(continuesSentence('La Clio a 82 000 km', 'Son contrôle est prévu.')).toBe(true); // première phrase non terminée
    expect(continuesSentence('Voici ce que j’ai trouvé :', 'La Clio a 82 000 km.')).toBe(true);
    expect(continuesSentence('La Clio a 82 000 km.', 'mais son contrôle est dépassé.')).toBe(true);
    expect(continuesSentence('La Clio a 82 000 km.', 'Son contrôle est prévu.')).toBe(false);
    expect(continuesSentence('Est-elle assurée ?', 'Oui, chez Assureur A.')).toBe(false);
    expect(continuesSentence('Le contrat est « tous risques ».', 'Il court jusqu’au 31/12/2026.')).toBe(false);
    expect(continuesSentence('Le contrat est (voir la facture).', '82 000 km au compteur.')).toBe(false);
    // Un long texte sans point final n'est pas un « morceau de phrase ».
    expect(continuesSentence('x'.repeat(161), 'Suite.')).toBe(false);
    expect(continuesSentence('', 'Suite.')).toBe(false);
  });

  it('phrase d’introduction sans donnée (« … : ») puis une affirmation : une seule phrase, un paragraphe', () => {
    const ia = reponseIa(claims(['Voici ce que j’ai trouvé :', [], false], [KM, ['asset_field:7:mileage']]));
    expect(formes(ia.answer)).toEqual(['paragraph']);
    expect(ia.claims).toHaveLength(1);
  });

  it('affirmation rejetée (source inconnue) : ni bloc vide, ni trou ; les autres gardent leur frontière ; étayage « partiel »', () => {
    const ia = reponseIa(claims([KM, ['asset_field:7:mileage']], ['Elle vaut 9 000 €.', ['doc:999']], [VIDANGE, ['doc:31']]));
    expect(ia.answer).toBe(`${KM}\n\n${VIDANGE}`);
    expect(ia.supportLevel).toBe('partial');
    expect(buildAnswerBlocks(ia.answer).every((b) => texteDe(b).trim().length > 0)).toBe(true);
    expect(ia.claims.map((c) => c.sourceIds)).toEqual([['asset_field:7:mileage'], ['doc:31']]);
  });

  it('affirmation non soutenue par sa source (T2-31) : toujours rejetée — le contrôle des faits n’est pas affaibli', () => {
    const ia = reponseIa(claims([KM, ['asset_field:7:mileage']], ['La vidange a coûté 999,00 €.', ['doc:31']]));
    expect(ia.answer).toBe(KM);
    expect(ia.supportEvents.some((e) => e.startsWith('CLAIM_UNSUPPORTED:'))).toBe(true);
  });

  it('`comparison` et `timeline` restent corrects, et les lignes structurées du modèle aussi (règle du 21/11 inchangée)', () => {
    const cmp = reponseIa({ mode: 'ANSWER', format: 'comparison', status: 'answered', criterion: 'kilométrage', items: [
      { targetId: 'asset:7', label: 'Clio', value: '82 000 km', sourceIds: ['asset_field:7:mileage'] },
      { targetId: 'asset:41', label: 'Polo', value: null, sourceIds: ['agenda:12'] },
    ] });
    expect(formes(cmp.answer)).toEqual(['paragraph', 'list']);
    const chrono = reponseIa({ mode: 'ANSWER', format: 'timeline', status: 'answered', events: [
      { date: '2026-02-04', text: 'Vidange', sourceIds: ['doc:31'] }, { date: '2027-03-12', text: 'Contrôle technique', sourceIds: ['agenda:12'] },
    ] });
    expect(chrono.answer).toBe('04/02/2026 — Vidange\n12/03/2027 — Contrôle technique');
    expect(formes(chrono.answer)).toEqual(['paragraph', 'paragraph']);
    const lignes = ['Chiffre clé : 189,90 € — dernière vidange', 'Détail :', '• Vidange : 189,90 €', '• Kilométrage : 82 000 km', KM];
    expect(formes(joinAnswerLines(lignes))).toEqual(['metric', 'paragraph', 'list', 'paragraph']);
  });
});

describe('C790C-CTL — validation et contrôle final : mêmes règles, frontières conservées', () => {
  const g = (answer: string) => ({ answer, claims: [], supportLevel: 'supported' as const });

  it('validation : le nombre de phrases compté ne dépend pas des frontières ; même verdict avec ou sans', () => {
    const avec = `${KM}\n\n${CT}\n\n${VIDANGE}`;
    const sans = `${KM} ${CT} ${VIDANGE}`;
    expect(countSentences(avec)).toBe(countSentences(sans));
    for (const intent of ['ACCOUNT_SEARCH', 'ACCOUNT_SUMMARY', 'ACCOUNT_COMPARISON', 'ACCOUNT_TIMELINE', 'HELP']) {
      const a = validateGeneratedAnswer(g(avec), intent);
      const s = validateGeneratedAnswer(g(sans), intent);
      expect(a?.violations, intent).toEqual(s?.violations);
      // La validation ne réécrit pas le texte : les frontières en sortent intactes.
      expect(a?.answer, intent).toBe(avec);
    }
  });

  const C = (claimKey: string, text: string, sourceIds: string[]) => ({ claimKey, text, sourceIds, derivation: 'direct' as const });
  const sourcesCtl = SOURCES.map((s) => ({ id: s.id, type: 'document', title: s.id, content: s.content }));

  it('contrôle final sans rejet : la réponse n’est pas réécrite (frontières intactes)', () => {
    const c = controlFinalAnswer({
      focus: null, path: 'generation', answer: `${KM}\n\n${CT}`, rebuild: true, sources: sourcesCtl,
      claims: [C('c1', KM, ['asset_field:7:mileage']), C('c2', CT, ['agenda:12'])],
    });
    expect(c.verdict).toBe('PASS');
    expect(c.answer).toBeNull();
  });

  it('contrôle final avec rejet : la réponse reconstruite garde UNE affirmation par paragraphe', () => {
    const regle = 'Vous avez déjà réglé cette facture.';
    const c = controlFinalAnswer({
      focus: null, path: 'generation', answer: `${KM}\n\n${regle}\n\n${VIDANGE}`, rebuild: true, sources: sourcesCtl,
      claims: [C('c1', KM, ['asset_field:7:mileage']), C('c2', regle, ['doc:31']), C('c3', VIDANGE, ['doc:31'])],
    });
    expect(c.rejected).toEqual([{ claimKey: 'c2', reason: 'SETTLEMENT_UNPROVEN' }]);
    expect(c.answer).toBe(`${KM}\n\n${VIDANGE}`);
    expect(formes(c.answer!)).toEqual(['paragraph', 'paragraph']);
    expect(c.kept.map((x) => x.sourceIds)).toEqual([['asset_field:7:mileage'], ['doc:31']]);
  });
});

/** Variante du coût de possession de Polo (moteur simulé par sa forme réelle `TcoResult`). */
type ReponseCanonique = ReturnType<typeof ownershipCostAnswer>;
type Repondu = Extract<NonNullable<ReponseCanonique>, { answer: string }>;
/** Une réponse est attendue (ni ambiguïté, ni périmètre non résolu, ni absence) : sinon le test échoue ici. */
const repondu = (r: ReponseCanonique): Repondu => {
  if (!r || !('answer' in r)) throw new Error('réponse attendue');
  return r;
};
const tco = (over: Partial<TcoResult> = {}) => repondu(ownershipCostAnswer(POLO as never, poloTco(over)));
const eur = (cents: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const indicateursDisponibles = {
  total: null,
  annualAverage: { documentedCents: 61_910, unavailableReason: null },
  net: { kind: 'ESTIMATED', cents: 147_641, documentedCents: 147_641, valuation: null, realizedPriceCents: null, disposalFeesCents: 0, unavailableReason: null, info: null },
  financing: { loans: [], costToDateCents: 0, remainingCents: 0, contractualTotalCents: null, estimated: false, basisLabel: null, outstanding: null },
} as unknown as TcoResult['indicators'];
const periodeConnue = { start: '2022-11-21', startSource: 'ASSET_DATA', end: '2026-11-21', endSource: 'TODAY', days: 1461, startStatus: 'RESOLVED', startKind: 'PURCHASE' } as TcoResult['period'];
const fiabilite = (o: Record<string, unknown>) => ({ ...poloTco().reliability, ...o }) as unknown as TcoResult['reliability'];
const pret = (label: string, status: string, cents: number | null) => ({ label, outstanding: { status, cents, asOf: '2026-10-05', label: `Capital restant dû du ${label} non établi : tableau d’amortissement manquant.` } });
const financement = (o: Record<string, unknown>) => ({ ...poloTco().indicators, financing: { loans: [], costToDateCents: 0, remainingCents: 0, contractualTotalCents: null, estimated: false, basisLabel: null, outstanding: null, ...o } }) as unknown as TcoResult['indicators'];

interface Variante { nom: string; r: ReturnType<typeof tco>; formes: AnswerBlock['kind'][]; contient?: RegExp[]; absent?: RegExp[] }
const VENT = ['paragraph', 'list'] as const;
const VARIANTES: Variante[] = [
  { nom: '0 poste (rubriques absentes) : ni annonce orpheline, ni liste vide',
    r: tco({ breakdown: [] }), formes: ['metric', ...VENT], absent: [/Ventilation/], contient: [/Limites :/] },
  { nom: '0 poste, aucune limite : le chiffre clé seul',
    r: tco({ breakdown: [], status: 'COMPLETE', indicators: null as unknown as TcoResult['indicators'] }), formes: ['metric'], absent: [/Ventilation|Limites|Autres indicateurs/] },
  { nom: '1 poste : une ventilation d’une ligne',
    r: tco({ breakdown: [poloTco().breakdown[0]] }), formes: ['metric', ...VENT, ...VENT], contient: [/Ventilation :\n• Entretien, réparations et travaux : /] },
  { nom: 'tous les indicateurs disponibles, dossier complet : aucune rubrique « Limites »',
    r: tco({ status: 'COMPLETE', period: periodeConnue, indicators: indicateursDisponibles,
      summary: { ...poloTco().summary, currentValue: { cents: 100_000, date: '2026-09-01', mode: null, source: null }, netEstimatedCents: 147_641, acquisitionStatus: 'DOCUMENTED' } as TcoResult['summary'] }),
    formes: ['metric', ...VENT, ...VENT], contient: [/Autres indicateurs :/, /Coût annuel moyen de possession/, /coût net estimé/], absent: [/Limites/, /non calculé/, /incomplet|partiel/] },
  { nom: 'statut partiel', r: tco({ status: 'PARTIAL' }), formes: ['metric', ...VENT, ...VENT], contient: [/• Résultat partiel\.$/], absent: [/Ce total peut être incomplet/] },
  { nom: 'statut incomplet (Polo)', r: tco(), formes: ['metric', ...VENT, ...VENT], contient: [/• Ce total peut être incomplet\.$/] },
  { nom: 'avoirs seuls', r: tco({ reductionsCents: 12_300 }), formes: ['metric', ...VENT, ...VENT], contient: [/• Avoirs : − 123,00 €/], absent: [/Remboursements|Indemnités/] },
  { nom: 'remboursements et indemnisations', r: tco({ refundsCents: 4_500, indemnitiesCents: 80_000 }), formes: ['metric', ...VENT, ...VENT],
    contient: [/• Remboursements : − 45,00 €\n• Indemnités : − 800,00 €/] },
  { nom: 'financement : coût du crédit et capital restant dû établi',
    r: tco({ indicators: financement({ loans: [pret('Prêt auto', 'ESTABLISHED', 640_000)], costToDateCents: 43_333, remainingCents: 21_000, contractualTotalCents: 64_333, estimated: false, basisLabel: 'selon l’échéancier du prêt', outstanding: { status: 'ESTABLISHED', cents: 640_000 } }) }),
    formes: ['metric', ...VENT, ...VENT, ...VENT], contient: [/• Coût du crédit à date/, /• Capital restant dû au 05\/10\/2026 : 6 400,00 €.*ce n’est pas un coût\./] },
  { nom: 'financement : capital restant dû établi pour une partie des prêts',
    r: tco({ indicators: financement({ loans: [pret('Prêt A', 'ESTABLISHED', 100_000), pret('Prêt B', 'UNKNOWN', null)], costToDateCents: 1_000, outstanding: { status: 'PARTIAL', cents: null } }) }),
    formes: ['metric', ...VENT, ...VENT, ...VENT], contient: [/• Capital restant dû établi pour une partie des prêts seulement : Prêt A 1 000,00 € au 05\/10\/2026\./] },
  { nom: 'financement : capital restant dû non établi — dit dans les limites, aucun zéro inventé',
    r: tco({ indicators: financement({ loans: [pret('Prêt A', 'UNKNOWN', null)], outstanding: { status: 'UNKNOWN', cents: null } }) }),
    formes: ['metric', ...VENT, ...VENT], contient: [/Limites :[\s\S]*• Capital restant dû du Prêt A non établi/], absent: [/Capital restant dû[^\n]*0,00 €/] },
  { nom: 'vente : prix réalisé connu, coût net final',
    r: tco({ disposed: true, status: 'COMPLETE', indicators: null as unknown as TcoResult['indicators'], summary: { ...poloTco().summary, netFinalCents: 147_641 } as TcoResult['summary'],
      disposal: { ...poloTco().disposal, realizedPriceCents: 100_000, resultKind: 'FINAL' } as TcoResult['disposal'] }),
    formes: ['metric', ...VENT, ...VENT], contient: [/Autres indicateurs :\n• Après la vente \(prix réalisé 1 000,00 €\), coût net final : 1 476,41 €\./], absent: [/Limites/] },
  { nom: 'cession : prix réalisé non documenté — dit dans les limites',
    r: tco({ disposed: true }), formes: ['metric', ...VENT, ...VENT], contient: [/• Le prix de cession réalisé n’est pas documenté : le coût net final n’est pas établi\./], absent: [/Coût net estimé non calculé/] },
  { nom: 'dépenses estimées (forfaits d’usage) : à part du chiffre principal, jamais additionnées à lui',
    r: tco({ summary: { ...poloTco().summary, estimatedUsageComplementCents: 36_000, totalWithEstimatesCents: 283_641 } as TcoResult['summary'],
      usage: { items: [], annualEstimateCents: 48_000, otherCurrencies: [], complement: null } as unknown as TcoResult['usage'] }),
    formes: ['metric', ...VENT, ...VENT, ...VENT], contient: [/• En incluant les estimations de dépenses d’usage \(360,00 € estimés/, /2 836,41 €/, /• Forfaits d’usage en cours : 480,00 € par an/] },
  { nom: 'date d’achat absente et valeur absente (Polo) : la cause est dite',
    r: tco(), formes: ['metric', ...VENT, ...VENT], contient: [/• Coût annuel moyen de possession non calculé : date d’achat du bien inconnue/, /• Coût net estimé non calculé : aucune estimation de valeur admissible/] },
  { nom: 'date d’achat incertaine : une seule limite sur la date, pas deux',
    r: tco({ period: { ...poloTco().period, startStatus: 'UNDETERMINED' } as TcoResult['period'] }), formes: ['metric', ...VENT, ...VENT],
    contient: [/• La date d’achat du bien est incertaine/], absent: [/Coût annuel moyen de possession non calculé/] },
  { nom: 'date d’achat connue : le point de départ est dit (légende ou premier indicateur), jamais perdu',
    r: tco({ period: periodeConnue }), formes: ['metric', ...VENT, ...VENT], contient: [/depuis l’achat du bien le /] },
  { nom: 'montants non comptabilisés : devise sans contre-valeur, montants communs non ventilés',
    r: tco({ reliability: fiabilite({ unconverted: [{ currency: 'CHF', amountMinor: 30_000, kind: 'REALIZED_COST' }], unallocated: { count: 2, eurCents: 12_000 } }) }),
    formes: ['metric', ...VENT, ...VENT], contient: [/• Non comptés \(devise sans contre-valeur en euros\) : 300,00 CHF\./, /• Des montants communs à plusieurs biens ne sont pas ventilés et ne sont pas comptés\./],
    absent: [/120,00 €/] },
];

describe('C790C-TCO — §2.A / §3 : toutes les variantes du coût de possession citées par la carte', () => {
  it.each(VARIANTES.map((v) => [v.nom, v] as const))('%s', (_nom, v) => {
    const { answer } = v.r;
    const blocs = buildAnswerBlocks(answer);
    expect(blocs.map((b) => b.kind)).toEqual(v.formes);
    for (const re of v.contient ?? []) expect(nb(answer)).toMatch(re);
    for (const re of v.absent ?? []) expect(nb(answer)).not.toMatch(re);
    // Le résultat en premier : le total du moteur, SEUL dans le chiffre clé.
    const cle = blocs[0];
    expect(cle.kind === 'metric' ? nb(cle.value.map((s) => s.text).join('')) : null).toBe(nb(eur(POLO_MONTANTS.total)));
    // Aucun bloc vide, aucune ligne en double, aucun signe technique, aucune partie fusionnée sur une ligne.
    expect(blocs.every((b) => texteDe(b).trim().length > 0)).toBe(true);
    const lignes = answer.split('\n').filter(Boolean);
    expect(new Set(lignes).size).toBe(lignes.length);
    expect(answer).not.toMatch(/[{}<>]|https?:|undefined|null|NaN/);
    // Les annonces de rubrique tiennent seules sur leur ligne (jamais suivies de leur contenu sur la même ligne).
    for (const l of lignes) if (/^(Ventilation|Autres indicateurs|Limites)\b/.test(l)) expect(l).toMatch(/^(Ventilation|Autres indicateurs|Limites) :$/);
    // Intégrité : une affirmation, une source, le total du moteur inchangé ; rien d'affiché hors du texte validé.
    expect(v.r.strategy).toBe('structured.ownership_cost');
    expect(v.r.claims).toHaveLength(1);
    expect(v.r.claims[0].text).toBe(answer);
    expect(v.r.sources.map((s) => s.id)).toEqual([`tco:${POLO.id}`]);
    expect(v.r.sources[0].meta?.cumulativeCostCents).toBe(POLO_MONTANTS.total);
    expect(nombres(answerBlocksText(blocs))).toEqual(nombres(answer));
    expect(answerBlocksFor(answer, answerBlocksForApi(answer))).toEqual(blocs);
  });

  it('chaque variante citée par la carte a son cas (aucune oubliée)', () => {
    const noms = VARIANTES.map((v) => v.nom).join(' | ');
    for (const mot of ['0 poste', '1 poste', 'tous les indicateurs disponibles', 'partiel', 'avoirs', 'indemnisations', 'financement', 'vente', 'cession',
      'estimées', 'date d’achat absente', 'valeur absente', 'non comptabilisés']) expect(noms, mot).toContain(mot);
  });

  it('ventilation : les montants des postes sont ceux du moteur, un poste par ligne, dans l’ordre du moteur', () => {
    const blocs = buildAnswerBlocks(tco().answer);
    const liste = blocs[2];
    expect(liste.kind === 'list' ? liste.items.map((it) => nb(it.map((s) => s.text).join(''))) : null).toEqual(
      poloTco().breakdown.map((b) => nb(`${b.label} : ${eur(b.costsCents)}`)),
    );
  });

  it('réponse SANS coût de possession (Standard) : deux paragraphes, aucun montant, aucun chiffre clé, aucune liste', () => {
    for (const r of [repondu(ownershipCostLockedAnswer(POLO)), repondu(ownershipCostLockedAnswer(null))]) {
      expect(formes(r.answer)).toEqual(['paragraph', 'paragraph']);
      expect(r.answer).not.toMatch(/\d|€|Chiffre clé|Ventilation|Limites/);
      expect(r.sources.map((s) => s.id)).toEqual(['product_rule:tco_premium']);
    }
  });
});

const lecture = (over: Partial<Reading> = {}): Reading => ({
  assetId: 7, assetName: 'Clio', key: 'mileage', label: 'Kilométrage', value: 82000, display: '82 000 km',
  origin: 'USER', originLabel: 'saisie par vous', updatedAt: null, from: 'key', evidence: null, openConflict: null, sensitive: false, ...over,
});
const clio = { id: 7, name: 'Clio', category: 'VEHICULE', subtype: null, purchaseDate: '2021-05-25', isRented: false, matched: 2 };
function port(over: Partial<Port> = {}): Port {
  return {
    today: () => '2026-09-30',
    findAssets: async (_a: number, w: string[]) => (w.includes('clio') ? [clio] : []),
    listAssets: async () => [clio],
    countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }), searchFacts: async () => [], searchDocuments: async () => [],
    readAssetField: async () => null,
    ...over,
  } as unknown as Port;
}
const ask = async (message: string, p: Port) => {
  const r = await answerFromData({ port: p, accountId: 1, message, thresholds: DEFAULT_THRESHOLDS });
  if (typeof r.answer !== 'string') throw new Error('réponse attendue');
  return { ...r, answer: r.answer };
};

describe('C790C-CMP — §1 : assemblages composites qui écrasaient une frontière', () => {
  it('valeur d’une fiche et conflit ouvert : la valeur seule, puis l’action à mener dans son paragraphe ; sans conflit : inchangé', () => {
    expect(fieldAnswer(lecture())).toBe('Kilométrage de Clio : 82 000 km.');
    const conflit = fieldAnswer(lecture({ openConflict: { question: 'Quel kilométrage retenir ?' } as never }));
    expect(conflit).toBe('Kilométrage de Clio : 82 000 km.\n\nUn autre document propose une valeur différente : c’est à arbitrer dans « À traiter » (Quel kilométrage retenir ?).');
    expect(formes(conflit)).toEqual(['paragraph', 'paragraph']);
  });

  it('valeur portée par plusieurs équipements : une par ligne ; un seul équipement : la phrase d’avant', () => {
    const entite = (entityName: string, display: string) => ({ target: { type: 'EQUIPMENT', id: 1 }, entityName, assetId: 7, key: 'serialNumber', label: 'Numéro de série', value: display, display, sensitive: false });
    const un = fieldAnswer(lecture({ display: null, entities: [entite('la chaudière', 'CH-123')] as never }));
    expect(un).toBe('Numéro de série de la chaudière : CH-123.');
    const deux = fieldAnswer(lecture({ display: null, entities: [entite('la chaudière', 'CH-123'), entite('la pompe à chaleur', 'PAC-456')] as never }));
    expect(deux).toBe('• Numéro de série de la chaudière : CH-123.\n• Numéro de série de la pompe à chaleur : PAC-456.');
    expect(formes(deux)).toEqual(['list']);
  });

  it('prochaine échéance : le résultat, la réserve sur la date prévisionnelle, puis les suivantes — trois parties distinctes', async () => {
    const lignes = [
      { id: 1, title: 'Contrôle technique', date: '2026-10-20', assetNames: ['Clio'], forecast: true },
      { id: 2, title: 'Assurance', date: '2026-12-01', assetNames: ['Clio'] },
      { id: 3, title: 'Vidange', date: '2027-02-04', assetNames: ['Clio'] },
    ];
    const r = await ask('Quelle est ma prochaine échéance ?', port({ upcomingAgenda: async () => lignes }));
    expect(r.strategy).toBe('structured.next_deadline');
    expect(formes(r.answer)).toEqual(['paragraph', 'paragraph', 'paragraph', 'list']);
    const b = buildAnswerBlocks(r.answer);
    expect(texteDe(b[0])).toMatch(/^Votre prochaine échéance : « Contrôle technique » \(Clio\), prévue le 20 octobre 2026/);
    expect(texteDe(b[1])).toBe('Cette date est prévisionnelle : elle sera confirmée par un document.');
    expect(texteDe(b[2])).toBe('Ensuite :');
    expect(texteDe(b[3])).toBe('« Assurance » le 1 décembre 2026\n« Vidange » le 4 février 2027');
    // Une seule échéance suivante : une phrase, pas une liste d'un élément.
    const deux = await ask('Quelle est ma prochaine échéance ?', port({ upcomingAgenda: async () => lignes.slice(1) }));
    expect(formes(deux.answer)).toEqual(['paragraph', 'paragraph']);
    expect(deux.answer.split('\n\n')[1]).toMatch(/^Ensuite : « Vidange » le 4 février 2027\.$/);
    // Une seule échéance, confirmée : UNE phrase, comme avant.
    const une = await ask('Quelle est ma prochaine échéance ?', port({ upcomingAgenda: async () => lignes.slice(2) }));
    expect(formes(une.answer)).toEqual(['paragraph']);
    expect(une.answer).not.toContain('\n');
    // L'affirmation porte toujours le texte entier, et la première échéance pour source.
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].text).toBe(r.answer);
  });

  it('état des analyses : en cours et en échec sont deux paragraphes ; un seul état : un paragraphe', async () => {
    const doc = (fileId: number, title: string, analysisState: string) => ({ fileId, title, date: null, assetName: null, matchedTerms: 0, analysisState });
    const deux = await ask('Où en est l’analyse de mes documents ?', port({ listDocumentsInAnalysis: async () => [doc(1, 'Facture A', 'ANALYZING'), doc(2, 'Devis B', 'ANALYSIS_FAILED')] }));
    expect(deux.strategy).toBe('structured.document_status');
    expect(formes(deux.answer)).toEqual(['paragraph', 'paragraph']);
    expect(deux.answer.split('\n\n')[0]).toMatch(/^1 document est en cours d’analyse : « Facture A »\./);
    expect(deux.answer.split('\n\n')[1]).toMatch(/^1 document n’a pas pu être analysé : « Devis B »\.$/);
    const un = await ask('Où en est l’analyse de mes documents ?', port({ listDocumentsInAnalysis: async () => [doc(1, 'Facture A', 'ANALYZING')] }));
    expect(formes(un.answer)).toEqual(['paragraph']);
  });

  it('refus pour plusieurs motifs : un paragraphe par motif ; un seul motif : inchangé', () => {
    const deux = analyzeScope('Comment réduire mes impôts ? Dois-je changer d’assurance ?');
    expect(deux.reasons.length).toBeGreaterThanOrEqual(2);
    expect(formes(deux.refusal!)).toHaveLength(deux.reasons.length);
    const un = analyzeScope('Comment réduire mes impôts ?');
    expect(un.reasons).toHaveLength(1);
    expect(un.refusal).not.toContain('\n');
  });
});

describe('C790C-HIS — §4.3 : ancien historique (messages enregistrés avant les correctifs)', () => {
  const ANCIEN_POLO = AVANT.polo.answer;

  it('ancienne réponse monobloc du coût de possession : UN paragraphe, texte intact, montants en évidence — ni plantage, ni réinterprétation', () => {
    expect(ANCIEN_POLO).not.toContain('\n');
    const blocs = answerBlocksFor(ANCIEN_POLO, undefined);
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph']);
    expect(answerBlocksText(blocs)).toBe(ANCIEN_POLO);
    const p = blocs[0];
    const forts = p.kind === 'paragraph' ? p.spans.filter((s) => s.strong).map((s) => nb(s.text)) : [];
    expect(forts).toEqual([POLO_MONTANTS.total, POLO_MONTANTS.entretien, POLO_MONTANTS.contrats, POLO_MONTANTS.autres].map((c) => nb(eur(c))));
    // Aucun chiffre clé, aucune liste n'est « devinée » dans un ancien texte.
    expect(blocs.some((b) => b.kind === 'metric' || b.kind === 'list' || b.kind === 'heading')).toBe(false);
  });

  it('toutes les anciennes réponses de référence (code d’origine) : aucune ne plante, aucun nombre perdu ni ajouté', () => {
    expect(Object.keys(AVANT).length).toBeGreaterThanOrEqual(24);
    for (const [k, cas] of Object.entries(AVANT)) {
      const blocs = answerBlocksFor(cas.answer, undefined);
      expect(blocs.length, k).toBeGreaterThan(0);
      expect(nombres(answerBlocksText(blocs)), k).toEqual(nombres(cas.answer));
      expect(blocs.every((b) => texteDe(b).trim().length > 0), k).toBe(true);
    }
  });

  it('ancienne réponse IA (affirmations recollées par une espace) : un paragraphe, tel qu’enregistré', () => {
    const ancien = `${KM} ${CT} ${VIDANGE}`;
    const blocs = answerBlocksFor(ancien, undefined);
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph']);
    expect(answerBlocksText(blocs)).toBe(ancien);
  });

  it('blocs enregistrés ou reçus d’une ancienne version : acceptés s’ils portent exactement le texte, sinon ignorés au profit du texte', () => {
    const ancien = `${KM} ${CT}`;
    const fideles = [{ kind: 'paragraph', spans: [{ text: ancien }] }];
    expect(answerBlocksFor(ancien, fideles)).toEqual(fideles);
    const local = buildAnswerBlocks(ancien);
    // Forme inconnue, texte différent, valeurs abîmées : le texte enregistré fait foi.
    for (const recus of [
      [{ kind: 'carte', spans: [{ text: ancien }] }], [{ kind: 'paragraph', spans: [{ text: 'Autre texte.' }] }],
      [{ kind: 'paragraph' }], 'texte', 42, {}, [], [null], [{ kind: 'metric', value: [{ text: 'sans chiffre' }], caption: null }],
    ]) expect(answerBlocksFor(ancien, recus)).toEqual(local);
    expect(parseAnswerBlocks([{ kind: 'paragraph', spans: [{ text: 'x', strong: 'oui' }] }])).toBeNull();
  });

  it('contenus limites d’un ancien fil : vide, nul, espaces, retours chariot Windows, lignes isolées — jamais d’exception', () => {
    expect(answerBlocksFor('', undefined)).toEqual([]);
    expect(buildAnswerBlocks(null)).toEqual([]);
    expect(buildAnswerBlocks(undefined)).toEqual([]);
    expect(buildAnswerBlocks('   \n \n')).toEqual([]);
    expect(formes('Ligne 1\r\nLigne 2')).toEqual(['paragraph', 'paragraph']);
    expect(formes('1. Une étape seule')).toEqual(['paragraph']);
    expect(formes('Le chiffre clé : c’est le total.')).toEqual(['paragraph']);
    expect(formes('| une barre isolée |')).toEqual(['paragraph']);
    expect(formes('Voici :')).toEqual(['paragraph']);
    const long = Array.from({ length: 200 }, (_, i) => `Ligne ${i + 1}.`).join('\n');
    expect(buildAnswerBlocks(long).length).toBeLessThanOrEqual(60);
  });
});

describe('C790C-DUR — §3 : l’exemple Polo n’est jamais en dur dans le code', () => {
  const RACINE = join(__dirname, '../../../../..');
  const fichiers = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' || n === 'test' || n === 'fixtures' ? [] : fichiers(p);
    return /\.(ts|tsx)$/.test(n) && !/\.(test|e2e)\.tsx?$/.test(n) ? [p] : [];
  });

  it('aucun montant de l’exemple (2 476,41 / 559,51 / 1 115,53 / 801,37, en euros ou en centimes) hors des tests', () => {
    const MONTANTS = /2[\s  ]?476,41|247_?641|559,51|55_?951|1[\s  ]?115,53|111_?553|801,37|80_?137/;
    const src = join(RACINE, 'src');
    const tous = fichiers(src);
    expect(tous.length).toBeGreaterThan(500);
    const fautifs = tous.filter((f) => MONTANTS.test(readFileSync(f, 'utf8')));
    expect(fautifs.map((f) => f.slice(RACINE.length + 1))).toEqual([]);
  });

  it('la réponse suit le moteur : d’autres montants et un autre bien donnent une autre réponse, même structure', () => {
    const autre = repondu(ownershipCostAnswer({ id: 99, name: 'Tondeuse', category: 'EQUIPEMENT', subtype: null } as never, poloTco({
      assetId: 99, summary: { ...poloTco().summary, cumulativeCostCents: 12_345 } as TcoResult['summary'],
      breakdown: [{ category: 'MAINTENANCE', label: 'Entretien, réparations et travaux', costsCents: 12_345, count: 1 }] as TcoResult['breakdown'],
    })));
    expect(nb(autre.answer)).toContain('Chiffre clé : 123,45 € — coût cumulé documenté de Tondeuse');
    expect(nb(autre.answer)).not.toMatch(/Polo|2 476,41|559,51|1 115,53|801,37/);
    expect(formes(autre.answer)).toEqual(['metric', 'paragraph', 'list', 'paragraph', 'list']);
  });
});
