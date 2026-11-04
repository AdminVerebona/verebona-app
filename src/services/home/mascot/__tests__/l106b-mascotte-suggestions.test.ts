/**
 * Lot 106B — ticket « Mascotte — réparer les suggestions existantes et ajouter
 * des invitations de découverte » : tests unitaires (T6 SIMULÉ, aucun réseau,
 * aucun prompt du dépôt modifié).
 *
 *  L106B-U01  cause DÉMONTRÉE : le prompt T6 livré ne porte pas le contrat
 *             `t6-suggestions-v3` → aucune question ; capacités lues ensemble ;
 *  L106B-U02  contrat des invitations : acceptées SANS référence de preuve ;
 *             rejets motivés (affirmation personnelle, référence, donnée du
 *             compte, chiffre, promesse, hors périmètre, référentiels, plafond) ;
 *  L106B-U03  contrôles des questions personnalisées NON affaiblis ;
 *  L106B-U04  rotation équitable, deux univers différents, suggestions passées ;
 *  L106B-U05  composition de la zone (au plus 2, question + invitation, « Autre
 *             suggestion » sans relecture), compte vide, invitations hors bulle ;
 *  L106B-U06  diagnostic explicite (codes stables) ;
 *  L106B-U07  T6 : invitations de la même sortie, cache écrit / relu, aucun
 *             nouvel appel à l'affichage après un échec récent ;
 *  L106B-U08  guide du PO, étape 13 : bloc rejoué contre les contrôles du BO et
 *             le validateur réel ; registre de conformité ;
 *  L106B-U09  cohérence : une invitation n'est jamais une question sans fondement ;
 *  L106B-U10  rendu : formulaire d'ajout existant (garde, quota), aucune couleur brute ;
 *  L106B-U11  trace BO « Suggestions de l'accueil » et relecture ciblée.
 *
 * Lot 108J (décision PO du ticket « Suggestions de l'accueil et de T2 ») :
 * les cas U04 (rotation des invitations), U05 (zone à deux suggestions,
 * « Autre suggestion »), U06 (diagnostic de la zone par la mascotte), U10
 * (invitation → formulaire d'ajout, route « Autre suggestion ») et U11
 * (ligne T6 « Suggestions de l'accueil », relecture 20 s) sont RETIRÉS : ils
 * décrivaient le dispositif remplacé (trois QUESTIONS servies par le service
 * unique `src/services/suggestions/shared`, aucun « Autre suggestion », T6
 * limité à la bulle). Restent les contrôles du CONTRAT T6 (prompt, validation
 * serveur, cache, guide du PO, corpus), toujours en vigueur pour la
 * qualification. Remplacement : `l108j-suggestions-partagees.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fonde, masterV3 } from './fixtures/t6-suggestions-v3';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
let configText: string | null = null;
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3 }),
}));

const R = await import('../t6-runner');
const S = await import('../t6-suggestions');
const D = await import('../discovery');
const { buildCandidates } = await import('../signals');
const { selectSubjects } = await import('../selector');
const { buildT6Input } = await import('../t6-contract');
const { storedGroundsOfEntry } = await import('../t6-suggestion-grounds');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { renderMasterPrompt, inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { listMasterTasks } = await import('@/services/ai/registry/operations');
const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
const { MARKER_CONTRACT_DECLARATIONS } = await import('@/services/ai/prompt-conformity/contracts');
type Row = import('../signals').MascotAgendaRow;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LIVRE = read('src/services/ai/prompts/mascot/t6_master_v1.txt');
const GUIDE = read('docs/exploitation/prompts-a-appliquer-par-le-po.md');
const BLOC3 = parseGuideBlocks(GUIDE).find((b) => b.id === 't6-suggestions-v3')!;
const BLOC13 = parseGuideBlocks(GUIDE).find((b) => b.id === 't6-discovery-v1')!;
/** Applique les blocs du guide comme le PO (même mécanique que l89c-guide-prompts). */
function appliquer(texte: string, b: typeof BLOC3): string {
  if (b.action === 'insert-before') return texte.replace(b.anchor!, `${b.text}\n\n${b.anchor}`);
  const i = texte.indexOf(b.from!);
  const j = texte.indexOf(b.to!);
  return `${texte.slice(0, i)}${b.text}\n\n${texte.slice(j)}`;
}
const T6_ETAPE3 = appliquer(LIVRE, BLOC3);
const T6_ETAPE13 = appliquer(T6_ETAPE3, BLOC13);

const TODAY = '2026-11-02';
const cupra: Row = {
  id: 11, title: 'Prochain contrôle technique — CUPRA LEON', date: '2028-04-18', forecast: false,
  requiresQualification: false, assetId: 1, assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture', dateRole: 'DEADLINE',
};
const DISC_CTX = D.discoveryContextOf(0, D.dayIndexOf(TODAY));
/** Compte « logement seul » (une maison, un document), avec ou sans section découverte. */
function maisonSeule(discovery: boolean) {
  return S.buildT6SuggestionContext({
    speech: 'Rien de particulier à vous signaler pour le moment.', attentionToday: false,
    state: { documentsTotal: 1 }, operations: 0, assets: [{ id: 5, name: 'Maison Lilas', documents: 1 }], agenda: [],
    labelOf: (r) => r.title, formatDate: (d) => d, today: TODAY, discovery: discovery ? DISC_CTX : null,
  });
}
function compteCupra(discovery: boolean) {
  return S.buildT6SuggestionContext({
    speech: 'Rien de particulier.', attentionToday: false, state: { documentsTotal: 2, deadlinesUpcoming: 1 }, operations: 0,
    assets: [{ id: 1, name: 'Cupra', documents: 2 }], agenda: [cupra], labelOf: () => 'Contrôle technique', formatDate: () => '18 avril 2028',
    today: TODAY, discovery: discovery ? DISC_CTX : null,
  });
}
const inv = (universe: string, documentKind: string, text: string, over: Record<string, unknown> = {}) => ({ kind: 'DISCOVERY', universe, documentKind, text, ...over });
const VOITURE = inv('VEHICLE', 'INVOICE', 'Ajoutez une facture d’entretien automobile pour retrouver les interventions et leur coût.');
const NOTICE = inv('EQUIPMENT', 'NOTICE', 'Une notice d’équipement ? Ajoutez-la pour retrouver ses consignes et ses références.');
const raisons = (b: ReturnType<typeof maisonSeule>, list: unknown[]) => S.validateT6SuggestionsDetailed(list, b.assetIds, b).rejected.map((r) => r.reason);

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockImplementation(async () => []);
  R.resetT6Breaker(); R.resetT6RecentFailures(); configText = null;
});

describe('L106B-U01 — cause démontrée : le prompt T6 livré ne porte pas le contrat des questions fondées', () => {
  it('texte livré : ni questions fondées ni invitations ; après l’étape 3 : questions ; après l’étape 13 : invitations', async () => {
    expect(S.promptSupportsSuggestionGrounds(LIVRE)).toBe(false);
    expect(D.promptSupportsDiscovery(LIVRE)).toBe(false);
    // Aucune version BO : le fichier du dépôt est examiné, sans présomption.
    expect(await R.t6SuggestionCapabilities()).toEqual({ grounds: false, discovery: false, source: 'repository' });
    expect(await R.t6SuggestionGroundsAvailable()).toBe(false);
    configText = T6_ETAPE3;
    expect(await R.t6SuggestionCapabilities()).toEqual({ grounds: true, discovery: false, source: 'bo' });
    configText = T6_ETAPE13;
    expect(await R.t6SuggestionCapabilities()).toEqual({ grounds: true, discovery: true, source: 'bo' });
    // Invitations sans questions fondées : jamais (même emplacement, même liste).
    configText = appliquer(LIVRE, BLOC13);
    expect(await R.t6SuggestionCapabilities()).toMatchObject({ grounds: false, discovery: false });
    // Version simulée des tests 87C (marqueurs v3 seuls).
    configText = masterV3(LIVRE);
    expect(await R.t6SuggestionCapabilities()).toMatchObject({ grounds: true, discovery: false });
  });
});

describe('L106B-U02 — contrat des invitations de découverte', () => {
  it('invitation générique ACCEPTÉE sans bien correspondant ni référence de preuve (compte « logement seul » → véhicule)', () => {
    const b = maisonSeule(true);
    const v = S.validateT6SuggestionsDetailed([VOITURE, NOTICE], b.assetIds, b);
    expect(v.rejected).toEqual([]);
    expect(v.accepted).toEqual([]); // aucune question : les invitations sont à part
    expect(v.acceptedDiscovery).toEqual([
      { key: 'DISC:VEHICLE:INVOICE', universe: 'VEHICLE', documentKind: 'INVOICE', text: VOITURE.text, cta: 'Ajouter une facture', origin: 'AI' },
      { key: 'DISC:EQUIPMENT:NOTICE', universe: 'EQUIPMENT', documentKind: 'NOTICE', text: NOTICE.text, cta: 'Ajouter une notice', origin: 'AI' },
    ]);
    // Compte vide (aucun bien) : même résultat, aucune preuve fictive exigée.
    const vide = S.buildT6SuggestionContext({ speech: '', attentionToday: false, state: null, operations: 0, assets: [], agenda: [], labelOf: (r) => r.title, formatDate: (d) => d, discovery: DISC_CTX });
    expect(S.validateT6SuggestionsDetailed([VOITURE], vide.assetIds, vide).acceptedDiscovery).toHaveLength(1);
  });

  it('affirmations personnelles injustifiées, références et données du compte : REJETÉES avec motif', () => {
    const b = maisonSeule(true);
    expect(raisons(b, [inv('VEHICLE', 'INVOICE', 'Ajoutez la facture d’entretien de votre voiture pour retrouver son coût.')])).toEqual(['discovery_personal_claim']);
    expect(raisons(b, [inv('EQUIPMENT', 'WARRANTY', 'Il vous manque la garantie de cet appareil : ajoutez-la pour la retrouver.')])).toEqual(['discovery_personal_claim']);
    expect(raisons(b, [inv('VEHICLE', 'INVOICE', 'Vous avez une voiture ? Ajoutez sa facture d’entretien pour en garder la trace.')])).toEqual(['discovery_personal_claim']);
    expect(raisons(b, [{ ...VOITURE, groundRefs: ['A1'] }])).toEqual(['discovery_with_grounds']);
    expect(raisons(b, [{ ...VOITURE, assetRef: 'A1' }])).toEqual(['discovery_with_ref']);
    expect(raisons(b, [{ ...VOITURE, deadlineRef: 'D1' }])).toEqual(['discovery_with_ref']);
    expect(raisons(b, [inv('HOUSING', 'INVOICE', 'Une facture de travaux pour Maison Lilas ? Ajoutez-la pour retrouver son coût.')])).toEqual(['discovery_cites_account']);
    expect(raisons(b, [inv('VEHICLE', 'INVOICE', 'Ajoutez une facture d’entretien de 2025 pour retrouver les interventions.')])).toEqual(['discovery_specific_fact']);
    expect(raisons(b, [inv('EQUIPMENT', 'WARRANTY', 'Ajoutez une garantie pour savoir quand elle expire et être prévenu à temps.')])).toEqual(['discovery_unfounded_promise']);
    expect(raisons(b, [inv('VEHICLE', 'DOCUMENT', 'Ajoutez une facture pour retrouver la prochaine intervention prévue.')])).toEqual(['discovery_unfounded_promise']);
    expect(raisons(b, [inv('HOUSING', 'DOCUMENT', 'Ajoutez une ordonnance médicale pour la retrouver facilement.')])).toEqual(['discovery_out_of_scope']);
    expect(raisons(b, [inv('HOUSING', 'DOCUMENT', 'Ajoutez votre passeport pour le retrouver facilement.')])).toEqual(['discovery_personal_claim']);
    expect(raisons(b, [inv('HOUSING', 'DOCUMENT', 'Ajoutez un passeport pour le retrouver facilement en voyage.')])).toEqual(['discovery_out_of_scope']);
    expect(raisons(b, [inv('BOAT', 'INVOICE', 'Ajoutez une facture de bateau pour retrouver son coût et sa date.')])).toEqual(['discovery_universe']);
    expect(raisons(b, [inv('HOUSING', 'RECEIPT', 'Ajoutez un reçu de travaux pour retrouver son coût et sa date.')])).toEqual(['discovery_document_kind']);
    expect(raisons(b, [inv('HOUSING', 'INVOICE', 'Ajoutez une facture 🏠 pour retrouver les travaux et leur coût.')])).toEqual(['discovery_format']);
    expect(raisons(b, [inv('HOUSING', 'INVOICE', 'Ajoute ta facture de travaux pour retrouver leur coût et leur date.')])).toEqual(['discovery_format']);
    expect(raisons(b, [inv('HOUSING', 'INVOICE', 'Trop court.')])).toEqual(['discovery_format']);
  });

  it('plafond (2 examinées), doublons, contrat non proposé : rejet individuel, jamais de substitution', () => {
    const b = maisonSeule(true);
    const H = inv('HOUSING', 'DIAGNOSTIC', 'Ajoutez un diagnostic du logement pour retrouver ses résultats et sa date.');
    const v = S.validateT6SuggestionsDetailed([VOITURE, VOITURE, H, NOTICE], b.assetIds, b);
    expect(v.rejected.map((r) => [r.index, r.reason])).toEqual([[1, 'duplicate'], [2, 'discovery_over_limit'], [3, 'discovery_over_limit']]);
    expect(v.acceptedDiscovery?.map((x) => x.key)).toEqual(['DISC:VEHICLE:INVOICE']);
    // Prompt sans `t6-discovery-v1` (contexte sans section) : aucune invitation de T6 publiée.
    const sans = maisonSeule(false);
    expect(raisons(sans, [VOITURE])).toEqual(['discovery_unsupported']);
    expect(sans.context.discovery).toBeUndefined();
    expect(maisonSeule(true).context.discovery).toEqual(DISC_CTX);
  });
});

describe('L106B-U03 — les contrôles des questions personnalisées ne sont pas affaiblis', () => {
  it('une question sans fondement reste rejetée, même quand les invitations sont admises ; aucune porte dérobée', () => {
    const b = compteCupra(true);
    // Affirmation personnelle injustifiée sous forme de question : sans fondement → rejet.
    const q = { question: 'Quand expire la garantie de ma Cupra ?', subject: 'ASSET', purpose: 'CONSULT', assetRef: 'A1', deadlineRef: null, decision: { relevant: true, answerable: true, preparationUseful: null }, informationNature: ['ASSET_DATA'] };
    expect(raisons(b, [q])).toEqual(['contract_missing_grounds']);
    expect(raisons(b, [{ ...q, kind: 'QUESTION' }])).toEqual(['contract_missing_grounds']);
    // Un élément déclaré « DISCOVERY » ne contourne pas les contrôles en citant une preuve.
    expect(raisons(b, [inv('VEHICLE', 'WARRANTY', 'Ajoutez la garantie de la Cupra pour retrouver sa durée.', { groundRefs: ['A1'] })])).toEqual(['discovery_with_grounds']);
    expect(raisons(b, [inv('VEHICLE', 'WARRANTY', 'Ajoutez la garantie de la Cupra pour retrouver sa durée.')])).toEqual(['discovery_cites_account']);
    // Type inconnu : jamais lu comme une question.
    expect(raisons(b, [{ ...fonde(b, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES']), kind: 'TIP' }])).toEqual(['format']);
    // Question fondée : toujours acceptée, et ses trois questions examinées malgré deux invitations.
    const qs = ['Quelle est ma prochaine échéance ?', 'Quels sont les documents de Cupra ?', 'Quand a lieu le Contrôle technique ?'];
    const v = S.validateT6SuggestionsDetailed([
      VOITURE, fonde(b, qs[0], ['ACC.DEADLINES']), NOTICE, fonde(b, qs[1], ['A1', 'A1.DOCS'], { assetRef: 'A1' }), fonde(b, qs[2], ['D1']),
      fonde(b, 'Une quatrième question ?', ['ACC.DEADLINES']),
    ], b.assetIds, b);
    expect(v.accepted.map((x) => x.question)).toEqual(qs);
    expect(v.acceptedDiscovery).toHaveLength(2);
    expect(v.rejected.map((r) => r.reason)).toEqual(['over_limit']);
  });
});

describe('L106B-U07 — T6 : invitations de la même sortie, cache, aucun appel redondant', () => {
  const subjects = selectSubjects(buildCandidates({
    accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
    onboarding: { activeAssets: [{ id: 1, name: 'Cupra' }], activeAssetCount: 1, documentCount: 2 }, toProcess: [], agenda: [cupra], acknowledgments: [],
  } as never).candidates);
  const INPUT = buildT6Input(subjects);
  const OUT = (suggestions: unknown) => ({ schemaVersion: 't6-output-v2', messages: INPUT.subjects.map((s) => ({ subjectId: s.subjectId, text: s.fallbackText, highlight: null })), suggestions });
  const execute = vi.fn();
  const deps = (wait = 6_000) => ({
    treatmentAvailable: async () => true, promptVersion: async () => 'v|cfg:3', previousBubbles: async () => [],
    execute: (r: unknown) => execute(r), displayWaitMs: () => wait,
  });
  const res = (data: unknown) => ({ data, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' });
  beforeEach(() => execute.mockReset());

  it('génération : questions ET invitations validées à part ; le contexte transmis porte la section découverte ; cache écrit avec les deux', async () => {
    const b = compteCupra(true);
    execute.mockResolvedValue(res(OUT([fonde(b, 'Quelle est ma prochaine échéance ?', ['ACC.DEADLINES']), VOITURE])));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: b }, deps());
    expect(o.status).toBe('generated');
    expect(o.suggestions?.map((x) => x.question)).toEqual(['Quelle est ma prochaine échéance ?']);
    expect(o.discovery?.map((x) => x.key)).toEqual(['DISC:VEHICLE:INVOICE']);
    const ctx = JSON.parse((execute.mock.calls[0][0] as { promptVariables: { SUGGESTION_CONTEXT: string } }).promptVariables.SUGGESTION_CONTEXT);
    expect(ctx.discovery).toMatchObject({ contract: 't6-discovery-v1', max: 2 });
    const ecriture = unsafe.mock.calls.find(([sql]) => sql.includes('INSERT INTO home_mascot_cache') && sql.includes('suggestion_contract'));
    const stockees = JSON.parse(String(ecriture![1]![7])) as Array<Record<string, unknown>>;
    expect(stockees.map((x) => x.kind ?? 'QUESTION')).toEqual(['QUESTION', 'DISCOVERY']);
    expect(stockees[1]).toEqual({ kind: 'DISCOVERY', text: VOITURE.text, universe: 'VEHICLE', documentKind: 'INVOICE' });
  });

  it('relecture du cache : invitations revalidées (aucun appel) ; entrée devenue incompatible (prompt revenu sans le contrat) : invalidée proprement', async () => {
    const b = compteCupra(true);
    unsafe.mockImplementation(async (sql: string) => (sql.startsWith('SELECT c.messages')
      ? [{ messages: OUT([]).messages, suggestions: [{ kind: 'DISCOVERY', text: NOTICE.text, universe: 'EQUIPMENT', documentKind: 'NOTICE' }], suggestion_contract: 't6-suggestions-v3', trace_id: 't' }]
      : []));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display', suggestions: b }, deps());
    expect(o.status).toBe('cache_hit');
    expect(execute).not.toHaveBeenCalled();
    expect(o.discovery?.map((x) => x.key)).toEqual(['DISC:EQUIPMENT:NOTICE']);
    const sansDecouverte = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display', suggestions: compteCupra(false) }, deps());
    expect(sansDecouverte.discovery ?? []).toEqual([]);
    expect(unsafe.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM home_mascot_cache WHERE account_id = $1 AND cache_key = ANY'))).toBe(true);
  });

  it('IA en erreur : à l’affichage suivant du même contexte, aucun nouvel appel (pas de relance à chaque rendu)', async () => {
    const b = compteCupra(true);
    execute.mockRejectedValue(new Error('fournisseur indisponible'));
    const o1 = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display', suggestions: b }, deps());
    expect(o1.status).toBe('error');
    const o2 = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'display', suggestions: b }, deps());
    expect(o2).toMatchObject({ status: 'error', error: R.T6_RECENT_FAILURE_NOTE });
    expect(execute).toHaveBeenCalledTimes(1);
    // La pré-génération peut réessayer (reprise bornée par le disjoncteur).
    await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h', mode: 'pregen', suggestions: b }, deps());
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('L106B-U08 — guide du PO, étape 13 (bloc `t6-discovery-v1`)', () => {
  it('bloc balisé, inséré avant « SORTIE FORMULATE » ; aucun emplacement nouveau ; marqueurs lus par le code', () => {
    expect(BLOC13).toMatchObject({ prompt: 't6', action: 'insert-before', anchor: 'SORTIE FORMULATE' });
    expect(LIVRE.split('SORTIE FORMULATE').length - 1).toBe(1);
    expect(T6_ETAPE3.split('SORTIE FORMULATE').length - 1).toBe(1);
    expect(inspectMasterTemplate(BLOC13.text).placeholders).toEqual([]);
    expect(D.promptSupportsDiscovery(T6_ETAPE13)).toBe(true);
    expect(S.promptSupportsSuggestionGrounds(T6_ETAPE13)).toBe(true);
    expect(GUIDE).toContain(D.T6_DISCOVERY_CONTRACT);
    expect(GUIDE).toContain(D.T6_DISCOVERY_OUTPUT_MARKER);
  });
  it('contrôles d’activation du BO : aucun bloquant ; rendu FORMULATE réel avec la section découverte', () => {
    expect(checkMasterPromptContent('T6', T6_ETAPE13).blocking).toEqual([]);
    const rendu = renderMasterPrompt(T6_ETAPE13, {
      masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: listMasterTasks('t6_master_v1'),
      variables: { INPUT_JSON: { subjects: [] }, SUGGESTION_CONTEXT: maisonSeule(true).context, INTERPELLATION_CONTEXT: null },
    });
    expect(rendu).toContain('t6-discovery-v1');
  });
  it('chaque exemple JSON du bloc passe le validateur serveur réel (compte « logement seul »)', () => {
    const exemples = BLOC13.text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    expect(exemples).toHaveLength(2);
    const b = maisonSeule(true);
    const v = S.validateT6SuggestionsDetailed(exemples, b.assetIds, b);
    expect(v.rejected).toEqual([]);
    expect(v.acceptedDiscovery?.map((x) => x.universe)).toEqual(['VEHICLE', 'EQUIPMENT']);
  });
  it('registre de conformité 99B : contrat déclaré, exige l’étape 3, détection = règle d’exécution', async () => {
    const d = MARKER_CONTRACT_DECLARATIONS.find((x) => x.id === 't6-discovery-v1')!;
    expect(d).toMatchObject({ treatment: 'T6', guideStep: 13, blockId: 't6-discovery-v1', requires: ['t6-suggestions-v3'], task: 'FORMULATE' });
    expect(await d.detect(T6_ETAPE13)).toBe(true);
    expect(await d.detect(T6_ETAPE3)).toBe(false);
  });
});

describe('L106B-U09 — cohérence COH-T6-SUGGESTIONS : une invitation n’est jamais une question sans fondement', () => {
  it('les éléments DISCOVERY du cache sont ignorés par le contrôle des fondements', () => {
    const g = { ref: 'ACC.DEADLINES', key: 'account:hasUpcomingDeadlines', version: 'present', nature: 'ACCOUNT_DATA' };
    const r = storedGroundsOfEntry([{ question: 'Q ?', grounds: [g] }, { kind: 'DISCOVERY', text: VOITURE.text, universe: 'VEHICLE', documentKind: 'INVOICE' }]);
    expect(r.perSuggestion).toHaveLength(1);
    expect(r.all.map((x) => x.key)).toEqual(['account:hasUpcomingDeadlines']);
  });
});

describe('L106B-U12 — corpus rejoué : cas P-T6-DISC-* (gardes serveur, aucune approbation)', () => {
  const fixtures = ['p-t6-disc-01-invitations-generiques.json', 'p-t6-disc-02-affirmation-personnelle.json']
    .map((f) => JSON.parse(read(`src/services/home/mascot/__fixtures__/${f}`)));
  it('chaque sortie enregistrée est jugée par le validateur réel conformément à l’attendu', () => {
    for (const f of fixtures) {
      expect(f.qualification).toEqual({ role: 'guard' });
      expect(D.evaluateDiscoveryCorpusCase(f.context.suggestionContext, f.recording.output, f.expected.discovery), f.case).toEqual([]);
    }
    // Attendu volontairement faux : l'écart est signalé (le cas n'est pas vert d'office).
    expect(D.evaluateDiscoveryCorpusCase(fixtures[1].context.suggestionContext, fixtures[1].recording.output, { accepted: ['DISC:VEHICLE:INVOICE'] })).toHaveLength(1);
  });
  it('manifeste : entrées DÉVELOPPEUR en garde serveur, jamais RÉFÉRENCE_APPROUVÉE', () => {
    const m = JSON.parse(read('src/services/ai/governance/master-corpus/certification/corpus-manifest.json')) as { entries: Array<{ sourceCaseId: string; status: string; provenance: string }> };
    const e = m.entries.filter((x) => x.sourceCaseId.startsWith('P-T6-DISC'));
    expect(e.map((x) => [x.sourceCaseId, x.provenance, x.status])).toEqual([
      ['P-T6-DISC-01', 'DEVELOPPEUR', 'GARDE_SERVEUR'], ['P-T6-DISC-02', 'DEVELOPPEUR', 'GARDE_SERVEUR'],
    ]);
  });
});
