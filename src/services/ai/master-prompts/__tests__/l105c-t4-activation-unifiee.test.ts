/**
 * Lot 105C — BO T4 : un prompt maître, une activation. Tests unitaires
 * (aucune base : dépôt simulé pour le service).
 *
 *  L105C-U01  bundle complet : SOURCE UNIQUE (contrat d'exécution), quatre TASK, contrats existants,
 *             schémas de sortie DISTINCTS et stricts par TASK
 *  L105C-U02  résolution refusée (jamais de repli en trois fonctions) : bundle absent, TASK non couverte,
 *             contrat de sortie inconnu, modèle non configuré
 *  L105C-U03  nouvelles versions : bundle complet quelle que soit la version de départ ; versions
 *             historiques lues à l'identique (signature, normalisation)
 *  L105C-U04  marqueurs : version à bundle sans `t4-agenda-representation-v1` ni `toProcessAssessment`
 *             → représentation et intervention disponibles ; version historique : règle d'époque intacte
 *  L105C-U05  fonctions d'une version (BO, réactivation) : complètes / limitées, en clair
 *  L105C-U06  service : activation refusée (texte, moteur) → aucune bascule, texte conservé ;
 *             configuration envoyée refusée ; brouillon existant normalisé sans perte
 *  L105C-U07  aucun numéro de contrat dupliqué dans l'écran ni les routes ; écran sans sélecteur
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

type Row = import('../master-prompt.repository').MasterPromptVersionRow;
type Exec = import('../structured-context').MasterExecutionConfig;
const base = vi.hoisted(() => ({ rows: [] as Row[], switches: 0, contentWrites: [] as string[] }));

vi.mock('@/services/ai/master-prompts/master-prompt.repository', async (orig) => {
  const vrai = await orig<typeof import('../master-prompt.repository')>();
  const env = (r: Row, e: string, t: string) => r.environment === e && r.treatment === t;
  return {
    ...vrai,
    masterPromptTablesReady: async () => true,
    getActive: async (e: string, t: string) => base.rows.find((r) => env(r, e, t) && r.status === 'ACTIVE') ?? null,
    getDraft: async (e: string, t: string) => base.rows.find((r) => env(r, e, t) && r.status === 'DRAFT') ?? null,
    getPromptVersion: async (id: number) => base.rows.find((r) => r.id === id) ?? null,
    listPromptVersions: async (e: string, t: string) => base.rows.filter((r) => env(r, e, t)),
    listTestRuns: async () => [],
    userEmails: async () => new Map(),
    listActivations: async () => [],
    switchActivePrompt: async () => { base.switches += 1; throw new Error('aucune activation attendue'); },
    insertDraft: async (p: { environment: string; treatment: string; masterPromptCode: string; content: string; basedOnId: number | null; execution?: Exec | null }) => {
      const r = ligne({ id: 100 + base.rows.length, status: 'DRAFT', content: p.content, execution: p.execution ?? null, basedOnId: p.basedOnId, versionNumber: 9 });
      base.rows.push(r);
      return r;
    },
    updateDraftContent: async (p: { id: number; content: string }) => {
      const r = base.rows.find((x) => x.id === p.id && x.status === 'DRAFT');
      if (!r) return null;
      base.contentWrites.push(p.content);
      r.content = p.content;
      r.contentSha256 = vrai.contentSha256(p.content);
      return r;
    },
    updateDraftExecution: async (p: { id: number; execution: Exec }) => {
      const r = base.rows.find((x) => x.id === p.id && x.status === 'DRAFT');
      if (!r) return null;
      r.execution = p.execution;
      return r;
    },
  };
});

const { getAiEnvironment } = await import('../../config/environment');
const ENV = getAiEnvironment();
function ligne(p: Partial<Row>): Row {
  const d = new Date('2026-11-02T08:00:00Z');
  return {
    id: 1, environment: ENV, treatment: 'T4', masterPromptCode: 't4_master_v1', versionNumber: 7, status: 'ACTIVE', content: '', contentSha256: 'x',
    origin: 'admin', basedOnId: null, createdBy: 1, createdAt: d, updatedBy: 1, updatedAt: d, activatedBy: 1, activatedAt: d, firstActivatedAt: d, execution: null, ...p,
  };
}

const sc = await import('../structured-context');
const { T4_EXECUTION_SPEC } = await import('../../agenda/master/t4-execution-contract');
const { T4_TASKS, T4_OPTIONAL_TASKS } = await import('../../agenda/master/t4-contract');
const { contractVersionsOf } = await import('../../gateway/output-resolution/runtime-contract');
const { masterOutputSchemaFor } = await import('../../gateway/master-output-schemas');
const { representationCapabilityOf } = await import('@/services/business-operations/semantic/decider');
const { assessT4Compatibility } = await import('../../agenda/master/t4-compatibility');
const { t4FunctionsOf, t4FunctionsComplete, t4LimitationsText } = await import('../../agenda/master/t4-functions');
const { checkMasterPromptContent } = await import('../master-prompt-checks');
const svc = await import('../master-prompt.service');

const RACINE = process.cwd();
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf8');
const LIVRE = lire('src/services/ai/prompts/agenda/t4_master_v1.txt');
const BUNDLE: Exec = {
  mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4',
  allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY', 'AGENDA_REPRESENTATION'], bundleId: 't4-bundle-v1',
};
const V2V3: Exec = { mode: 'STRUCTURED_CONTEXT', inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3', allowedTasks: ['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY'] };
const V3V4_HISTORIQUE: Exec = { ...BUNDLE, bundleId: undefined };
delete (V3V4_HISTORIQUE as Partial<Exec>).bundleId;
const existe = (n: string, v: number) => contractVersionsOf(n).includes(v);

beforeEach(() => { base.rows = []; base.switches = 0; base.contentWrites = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe('L105C-U01 — bundle complet : source unique, quatre TASK, sorties distinctes et strictes', () => {
  it('déclaré par le contrat d’exécution ; couvre TOUTES les TASK connues ; contrats existants et valides', () => {
    expect(T4_EXECUTION_SPEC.completeBundle).toEqual({ id: 't4-bundle-v1', inputContractVersion: 't4_input_v3', outputContractVersion: 't4_output_v4', tasks: [...T4_TASKS, ...T4_OPTIONAL_TASKS] });
    expect(sc.completeBundleConfig(T4_EXECUTION_SPEC)).toEqual(BUNDLE);
    expect([...T4_EXECUTION_SPEC.knownTasks].sort()).toEqual([...BUNDLE.allowedTasks!].sort());
    expect(sc.checkExecutionConfig(T4_EXECUTION_SPEC, BUNDLE, existe)).toEqual([]);
    // Le texte livré et l'exécution sans version BO ne changent pas (aucun déploiement ne modifie ce qui s'exécute).
    expect(T4_EXECUTION_SPEC.defaults).toEqual(V2V3);
    expect(sc.executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'file' })).toEqual(V2V3);
  });

  it('résolution : contrat runtime DISTINCT par TASK, chacun strict (aucun JSON générique commun)', () => {
    const r = svc.resolveBundleFor('t4_master_v1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frozen.outputs).toEqual({
      CLASSIFY_EVENT: 'T4ClassifyEventV3Output@3', VERIFY_COMPLETION: 'T4VerifyCompletionOutput@1',
      TEMPORAL_AMBIGUITY: 'T4TemporalAmbiguityOutput@1', AGENDA_REPRESENTATION: 'T4AgendaRepresentationOutput@1',
    });
    expect(new Set(Object.values(r.frozen.outputs)).size).toBe(4);
    // Chaque schéma refuse la sortie d'une autre branche et un objet générique.
    const generique = { task: 'CLASSIFY_EVENT', result: 'ok' };
    for (const nom of ['T4ClassifyEventV3Output', 'T4VerifyCompletionOutput', 'T4TemporalAmbiguityOutput', 'T4AgendaRepresentationOutput']) {
      const schema = masterOutputSchemaFor(nom)!;
      expect(schema).toBeTruthy();
      expect(schema.safeParse(generique).success).toBe(false);
      expect(schema.safeParse({ task: 'AUTRE' }).success).toBe(false);
    }
  });
});

describe('L105C-U02 — bundle non supporté : refus explicite, jamais trois fonctions en silence', () => {
  const ok = { contractExists: existe, modelConfigured: () => true };
  it('bundle absent', () => {
    const { completeBundle: _x, ...sans } = T4_EXECUTION_SPEC;
    expect(sc.resolveCompleteBundle(sans, ok)).toMatchObject({ ok: false, issues: [{ code: 'BUNDLE_UNDECLARED' }] });
  });
  it('TASK non couverte, contrat de sortie inconnu, modèle non configuré', () => {
    const partiel = { ...T4_EXECUTION_SPEC, completeBundle: { ...T4_EXECUTION_SPEC.completeBundle!, tasks: [...T4_TASKS] } };
    const r1 = sc.resolveCompleteBundle(partiel, ok);
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.issues.map((i) => i.code)).toContain('BUNDLE_INCOMPLETE');

    const sortie = { ...T4_EXECUTION_SPEC, completeBundle: { ...T4_EXECUTION_SPEC.completeBundle!, outputContractVersion: 't4_output_v9' } };
    const r2 = sc.resolveCompleteBundle(sortie, ok);
    expect(!r2.ok && r2.issues.map((i) => i.code)).toContain('OUTPUT_CONTRACT_INVALID');
    // Ancien couple v2 / v3 : ne décrit pas AGENDA_REPRESENTATION → refus, pas de version partielle.
    const ancien = { ...T4_EXECUTION_SPEC, completeBundle: { ...T4_EXECUTION_SPEC.completeBundle!, inputContractVersion: 't4_input_v2', outputContractVersion: 't4_output_v3' } };
    const r3 = sc.resolveCompleteBundle(ancien, ok);
    expect(r3.ok).toBe(false);
    expect(!r3.ok && r3.issues.map((i) => i.message).join(' ')).toMatch(/AGENDA_REPRESENTATION/);

    const r4 = sc.resolveCompleteBundle(T4_EXECUTION_SPEC, { contractExists: existe, modelConfigured: (t) => t !== 'AGENDA_REPRESENTATION' });
    expect(r4).toMatchObject({ ok: false, issues: [{ code: 'MODEL_CONFIG_INVALID', task: 'AGENDA_REPRESENTATION' }] });
  });
});

describe('L105C-U03 — nouvelles versions et versions historiques', () => {
  it('nouvelle version : bundle complet depuis LEGACY, v1, v2/v3 (texte hérité, jamais les anciens sélecteurs)', () => {
    for (const depart of [sc.LEGACY_EXECUTION, V2V3, { ...V2V3, inputContractVersion: 't4_input_v1', outputContractVersion: 't4_output_v1' }, V3V4_HISTORIQUE]) {
      expect(sc.draftExecutionConfig('t4_master_v1', depart)).toEqual(BUNDLE);
    }
    // Autres prompts : aucun bundle, aucune configuration.
    expect(sc.draftExecutionConfig('t3_master_v1', null)).toBeNull();
  });
  it('identifiant de bundle conservé par la normalisation ; signature distincte d’une version historique de mêmes contrats', () => {
    expect(sc.normalizeExecutionConfig(BUNDLE)).toEqual(BUNDLE);
    expect(sc.normalizeExecutionConfig(V3V4_HISTORIQUE)).toEqual(V3V4_HISTORIQUE);
    expect(sc.executionSignature(BUNDLE)).not.toBe(sc.executionSignature(V3V4_HISTORIQUE));
    expect(sc.isBundleExecution(BUNDLE)).toBe(true);
    expect(sc.isBundleExecution(V3V4_HISTORIQUE)).toBe(false);
  });
  it('texte historique à emplacements dans une nouvelle version : avertissement, jamais le mode legacy ni un blocage', () => {
    const legacy = lire('src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt');
    const r = checkMasterPromptContent('T4', legacy, BUNDLE);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('STRUCTURED_PLACEHOLDER_PRESENT');
  });
});

describe('L105C-U04 — plus de verrou par marqueur pour une version à bundle complet', () => {
  const sansMarqueur = LIVRE.replaceAll('t4-agenda-representation-v1', '').replaceAll('toProcessAssessment', 'évaluation demandée');
  it('représentation Agenda : disponible sans le marqueur, et après reformulation complète du texte', () => {
    expect(LIVRE).not.toContain('t4-agenda-representation-v1');
    expect(representationCapabilityOf({ text: LIVRE, version: 'pv1', execution: BUNDLE })).toEqual({ available: true, version: 'pv1', reason: 'AVAILABLE' });
    expect(representationCapabilityOf({ text: 'Tu es T4. Règles métier entièrement reformulées.', version: 'pv2', execution: BUNDLE }))
      .toEqual({ available: true, version: 'pv2', reason: 'AVAILABLE' });
    // Bundle dont les contrats ne décrivent plus la TASK (code incompatible) : indisponible, jamais forcé.
    expect(representationCapabilityOf({ text: LIVRE, version: 'pv3', execution: { ...BUNDLE, outputContractVersion: 't4_output_v3' } }))
      .toMatchObject({ available: false, contractState: 'CONTRACTS_MISSING' });
  });
  it('version historique (sans bundle) : règle d’époque INCHANGÉE — marqueur exigé', () => {
    expect(representationCapabilityOf({ text: LIVRE, version: 'h', execution: V3V4_HISTORIQUE })).toMatchObject({ available: false, contractState: 'MARKER_MISSING' });
    expect(representationCapabilityOf({ text: `${LIVRE}\nt4-agenda-representation-v1`, version: 'h', execution: V3V4_HISTORIQUE })).toMatchObject({ available: true });
  });
  it('intervention « À traiter » : aucun repère textuel exigé pour une version à bundle', () => {
    const a = assessT4Compatibility({ spec: T4_EXECUTION_SPEC, execution: BUNDLE, content: sansMarqueur, referenceText: LIVRE });
    expect(a).toMatchObject({ compatible: true, textReady: true, remedy: 'NONE', issues: [] });
    // Version historique : diagnostic textuel d'époque conservé.
    expect(assessT4Compatibility({ spec: T4_EXECUTION_SPEC, execution: V2V3, content: sansMarqueur, referenceText: LIVRE }).textReady).toBe(false);
  });
});

describe('L105C-U05 — fonctions d’une version, en clair', () => {
  it('bundle : quatre fonctions complètes ; v2/v3 : représentation absente ; legacy : intervention partielle', () => {
    const b = t4FunctionsOf({ text: 'texte libre', execution: BUNDLE });
    expect(b.map((f) => f.task)).toEqual(['CLASSIFY_EVENT', 'VERIFY_COMPLETION', 'TEMPORAL_AMBIGUITY', 'AGENDA_REPRESENTATION']);
    expect(t4FunctionsComplete(b)).toBe(true);
    expect(t4LimitationsText(b)).toBeNull();

    const h = t4FunctionsOf({ text: LIVRE, execution: V2V3 });
    expect(h.find((f) => f.task === 'AGENDA_REPRESENTATION')).toMatchObject({ available: false });
    expect(t4LimitationsText(h)).toMatch(/^Fonctions limitées : Représentation Agenda multi-événements — indisponible/);

    const l = t4FunctionsOf({ text: LIVRE, execution: sc.LEGACY_EXECUTION });
    expect(l.find((f) => f.task === 'CLASSIFY_EVENT')).toMatchObject({ available: true, partial: true });
    expect(t4FunctionsComplete(l)).toBe(false);
    // Aucun nom de contrat dans les motifs montrés au PO.
    for (const f of [...b, ...h, ...l]) expect(f.reason ?? '').not.toMatch(/t4_(input|output)_v\d/);
  });
});

describe('L105C-U06 — service : activation unifiée', () => {
  it('texte vide : refus TEXT_INVALID, aucune bascule', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: V2V3 }), ligne({ id: 2, status: 'DRAFT', content: LIVRE, execution: V2V3 }));
    await expect(svc.activateEditedVersion('T4', { content: '   ', draftId: 2 }, 5)).rejects.toMatchObject({ code: 'TEXT_INVALID', httpStatus: 422 });
    expect(base.switches).toBe(0);
  });

  it('moteur incompatible : message unique, détail, texte NON enregistré conservé dans le brouillon, aucune bascule', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: V2V3 }), ligne({ id: 2, status: 'DRAFT', content: LIVRE, execution: V2V3 }));
    const b = T4_EXECUTION_SPEC.completeBundle as { outputContractVersion: string };
    const avant = b.outputContractVersion;
    b.outputContractVersion = 't4_output_v9';
    try {
      const e = await svc.activateEditedVersion('T4', { content: `${LIVRE}\nModification non enregistrée.`, draftId: 2 }, 5).catch((x) => x);
      expect(e).toMatchObject({ code: 'ENGINE_INCOMPATIBLE', httpStatus: 422, message: 'Impossible d’activer T4 : configuration du moteur incompatible' });
      expect(e.details.draftSaved).toBe(true);
      expect(e.details.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(e.message)).not.toMatch(/choisissez|sélectionnez|cochez/i);
    } finally { b.outputContractVersion = avant; }
    expect(base.switches).toBe(0);
    expect(base.rows.find((r) => r.id === 2)!.content).toBe(`${LIVRE}\nModification non enregistrée.`);
    expect(base.rows.find((r) => r.id === 1)).toMatchObject({ status: 'ACTIVE', content: LIVRE, execution: V2V3 });
  });

  it('brouillon remplacé entre-temps : refus DRAFT_CHANGED, rien d’écrit', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: V2V3 }), ligne({ id: 3, status: 'DRAFT', content: 'autre', execution: BUNDLE }));
    await expect(svc.activateEditedVersion('T4', { content: 'mon texte', draftId: 2 }, 5)).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    expect(base.contentWrites).toEqual([]);
  });

  it('autres prompts : pas d’activation unifiée ; T4 : configuration envoyée refusée (gérée par le serveur)', async () => {
    expect(svc.isUnifiedActivation('T4')).toBe(true);
    for (const t of ['T1', 'T2', 'T3', 'T6'] as const) expect(svc.isUnifiedActivation(t)).toBe(false);
    await expect(svc.activateEditedVersion('T3', { content: 'x' }, 5)).rejects.toMatchObject({ code: 'UNIFIED_ACTIVATION_UNSUPPORTED' });
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: V2V3 }), ligne({ id: 2, status: 'DRAFT', content: LIVRE, execution: BUNDLE }));
    await expect(svc.saveDraftExecution('T4', 2, V2V3, 5)).rejects.toMatchObject({ code: 'EXECUTION_MANAGED_BY_SERVER' });
    expect(base.rows.find((r) => r.id === 2)!.execution).toEqual(BUNDLE);
  });

  it('« Modifier » depuis t4_input_v2 / t4_output_v3 : brouillon aux quatre fonctions, aucune erreur de sélection ; brouillon existant normalisé, texte conservé', async () => {
    base.rows.push(ligne({ id: 1, content: LIVRE, execution: V2V3 }));
    const d = await svc.startDraft('T4', 5);
    expect(d).toMatchObject({ status: 'DRAFT', content: LIVRE, execution: BUNDLE });
    const detail = await svc.getPromptDetail('T4');
    expect(detail.draft?.issues).toEqual([]);
    expect(detail.draft?.functions?.every((f) => f.available && !f.partial)).toBe(true);
    expect(JSON.stringify(detail.draft?.issues)).not.toMatch(/ne décrit pas la TASK|ne couvre pas la TASK/);
    expect(detail.unified).toMatchObject({ bundleIssues: [], bundle: { id: 't4-bundle-v1' } });
    expect(detail.unified?.activeFunctions.find((f) => f.task === 'AGENDA_REPRESENTATION')).toMatchObject({ available: false });

    base.rows = [ligne({ id: 1, content: LIVRE, execution: V2V3 }), ligne({ id: 4, status: 'DRAFT', content: 'Texte en cours du PO', execution: { ...V2V3, allowedTasks: [...V2V3.allowedTasks!, 'AGENDA_REPRESENTATION'] } })];
    const norm = await svc.getPromptDetail('T4');
    expect(norm.draft).toMatchObject({ id: 4, content: 'Texte en cours du PO', execution: BUNDLE, issues: [] });
    expect(base.switches).toBe(0);
    // Version active jamais touchée par la normalisation.
    expect(base.rows.find((r) => r.id === 1)!.execution).toEqual(V2V3);
  });
});

describe('L105C-U07 — écran et routes : aucun choix technique, aucun numéro de contrat recopié', () => {
  const ecran = lire('src/app/admin/ai-config/_components/T4MasterPromptEditor.tsx');
  const routes = [
    lire('src/app/api/admin/ai/master-prompts/[treatment]/activate/route.ts'),
    lire('src/app/api/admin/ai/master-prompts/[treatment]/draft/route.ts'),
  ];
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('un texte, « Activer la version », brouillon et test facultatifs, détails techniques repliés', () => {
    for (const t of ['Prompt maître T4', 'Activer la version', 'Enregistrer le brouillon', 'Tester T4', 'Détails techniques (lecture seule)',
      'Historique des versions', 'Réactiver cette version', 'Journal des activations', 'Impossible d’activer T4 : configuration du moteur incompatible']) {
      expect(ecran).toContain(t);
    }
    expect(code(ecran).match(/<Textarea/g)).toHaveLength(1);
    // « Activer la version » envoie le texte ÉDITÉ (même non enregistré) au serveur.
    expect(ecran).toMatch(/\/activate`, \{ content: texte, draftId: draft\?\.id \?\? null \}/);
    // Jamais conditionné par un test ni par « Enregistrer ».
    expect(ecran).toMatch(/disabled=\{busy !== null \|\| vide \|\| tropLong\}/);
  });
  it('aucun sélecteur de mode / contrat / TASK, aucune consigne de sélection', () => {
    const c = code(ecran);
    expect(c).not.toMatch(/<select|type="checkbox"|LEGACY_TEMPLATE<\/option>|onChange=\{\(e\) => changer/);
    expect(c).not.toMatch(/Cochez|Sélectionnez|choisissez t4_|t4_(input|output)_v\d/i);
    expect(c).toContain('managed');
    for (const r of routes) expect(code(r)).not.toMatch(/t4_(input|output)_v\d/);
  });
  it('aucune couleur brute', () => {
    expect(code(ecran)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/);
  });
});
