/**
 * Recherche, sources, actions et présentation — CDC §8.2, §9.2, §9.4, §9.5,
 * §10.4, §11.4, §12.1, §12.2, §13.7, §13.8, §14.1, §19.4, §19.8, §19.10,
 * §20.1, §22.7, §22.11, CA-24.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const dispo = await import('../source-availability.service');
const { trierParContribution, runAssistant } = await import('../assistant-orchestrator.service');
const { explanationDetails } = await import('../explanation');
const { resolveActions, offrePermet } = await import('../action-resolver.service');
const { analyserPeriode, dansPeriode } = await import('../query-period');
// Lot 16b-2 : découpe canonique seule (l'ancienne `analyserRequete` est retirée).
const { analyserRequeteCanonique } = await import('../retrieval.service');
const { bonusPeriode, bonusType } = await import('../../registries/retrieval-adapters');
const { dedupeLogique } = await import('../source-dedupe');
const { likePatternsTolerants, nearMatchRatio, tokenizeQuery } = await import('../query-terms');
const { answerFromData } = await import('../data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../sufficiency');
const { routeDeterministic, entityHintsFor, routeClarificationReason } = await import('../intent-router.service');
const { tryDeterministic } = await import('../deterministic-answer.service');
const { buildPeriodClarification, buildActionClarification } = await import('../clarification-builder');
const { candidatToujoursValide, inputDeReprise } = await import('../clarification.service');
const { suggestionsForRoute } = await import('../../registries/capability-registry');
const { parseHelpCorpus, searchHelpCorpus } = await import('../help-corpus.service');
const { agregerQuestions, expurgerQuestion } = await import('../unanswered-help.repository');
const { hrefSource } = await import('../entity-ref');
const { ACTION_CATALOG_VERSION } = await import('../../types/actions');

type Source = import('../../types/sources').RetrievedSource;
type Resolved = import('../../types/sources').ResolvedSource;
type Port = import('../data-answer.service').AccountDataPort;
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;
type Requeteur = import('../source-availability.service').Requeteur;

const TODAY = '2026-09-27';

// ── §19.10 — revérification de disponibilité, par type de source ─────────

/** Base factice : identifiants vivants par table, et journal des requêtes. */
function fausseBase(vivants: Record<string, number[]>) {
  const requetes: Array<{ sql: string; ids: number[]; compte: number }> = [];
  const requeteur: Requeteur = async (sql, params) => {
    const [ids, compte] = params as [number[], number];
    requetes.push({ sql, ids, compte });
    const table = Object.keys(vivants).find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    return compte === 7 && table ? ids.filter((i) => vivants[table].includes(i)).map((id) => ({ id })) : [];
  };
  return { requeteur, requetes };
}
const resolved = (id: string, type: Resolved['type'] = 'asset_field'): Resolved =>
  ({ id, type, typeLabel: 'x', title: id, excerpt: '', isAvailable: true, openAction: { type: 'OPEN_ASSET' } as never });

describe('§19.10 — disponibilité revérifiée dans la BONNE table (une requête par famille)', () => {
  it.each([
    ['asset_3', 'asset_field', 'assets'],
    ['doc_5', 'document', 'asset_files'],
    ['agenda_9', 'agenda_item', 'agenda_items'],
    ['equipment_12', 'asset_field', 'equipments'],
    ['room_7', 'asset_field', 'substructures'], // pièce = sous-structure (D-G, lot 20)
    ['supplier_4', 'supplier', 'suppliers'],
    ['export_2', 'export_item', 'export_generation'],
  ] as const)('%s (%s) est vérifié dans « %s »', async (id, type, table) => {
    // Vivant : lien conservé.
    const vivant = fausseBase({ [table]: [Number(id.split('_')[1])] });
    const [ok] = await dispo.marquerDisponibilite([resolved(id, type)], 7, vivant.requeteur);
    expect(ok.isAvailable).toBe(true);
    expect(vivant.requetes).toHaveLength(1);
    expect(vivant.requetes[0].sql).toMatch(new RegExp(`FROM ${table}\\b`));
    // Supprimé : lien retiré.
    const mort = fausseBase({ [table]: [] });
    const [ko] = await dispo.marquerDisponibilite([resolved(id, type)], 7, mort.requeteur);
    expect(ko.isAvailable).toBe(false);
    expect(ko.openAction).toBeNull();
  });

  it('régression : un équipement n’est plus vérifié dans `assets` avec son propre identifiant', async () => {
    // Le bien n° 12 existe, l'équipement n° 12 a été supprimé.
    const b = fausseBase({ assets: [12], equipments: [] });
    const [s] = await dispo.marquerDisponibilite([resolved('equipment_12')], 7, b.requeteur);
    expect(s.isAvailable).toBe(false);
    expect(b.requetes.every((r) => !/FROM assets WHERE/.test(r.sql))).toBe(true);
  });

  it('pièces et équipements : périmètre par le bien parent ; fournisseurs : statut ≠ deleted', () => {
    expect(dispo.REQUETES_DISPONIBILITE.equipment).toMatch(/JOIN assets a ON a.id = e.asset_id[\s\S]*a.account_id = \$2[\s\S]*a.deleted_at IS NULL/);
    expect(dispo.REQUETES_DISPONIBILITE.room).toMatch(/JOIN assets a ON a.id = r.asset_id[\s\S]*a.account_id = \$2/);
    expect(dispo.REQUETES_DISPONIBILITE.supplier).toMatch(/status <> 'deleted'/);
    // L'agenda n'a pas de suppression logique : pas de `deleted_at` (la requête échouait).
    expect(dispo.REQUETES_DISPONIBILITE.agenda_item).not.toMatch(/deleted_at/);
  });

  it('autre compte = indisponible ; identifiants non décodables intouchés ; « À traiter » revérifié (T2-45) ; panne : disponible', async () => {
    const b = fausseBase({ asset_files: [5] });
    const [etranger] = await dispo.marquerDisponibilite([resolved('doc_5', 'document')], 8, b.requeteur);
    expect(etranger.isAvailable).toBe(false);
    const [aide, todo] = await dispo.marquerDisponibilite([resolved('AID-DOC-001', 'help_entry'), resolved('todo_3', 'to_process_item')], 7, b.requeteur);
    expect(aide.isAvailable).toBe(true);
    // Lot 16b-2 : lecture canonique seule — un élément « À traiter » résolu
    // (absent de `to_process_actions` non résolus) n'est plus disponible.
    expect(todo.isAvailable).toBe(false);
    const ouvert = fausseBase({ to_process_actions: [3] });
    expect((await dispo.marquerDisponibilite([resolved('todo_3', 'to_process_item')], 7, ouvert.requeteur))[0].isAvailable).toBe(true);
    const enPanne = await dispo.marquerDisponibilite([resolved('doc_5', 'document')], 7, async () => { throw new Error('panne'); });
    expect(enPanne[0].isAvailable).toBe(true);
  });

  it('cartes relues depuis l’historique : l’objet supprimé perd son lien et le dit', async () => {
    const b = fausseBase({ asset_files: [1], suppliers: [] });
    const messages = [
      { id: 1, result_groups_json: [{ type: 'document', label: 'Documents', total: 2, hasMore: false, moreHref: null, items: [
        { id: 'doc_1', typeLabel: 'Document', title: 'A', subtitle: null, date: null, status: null, excerpt: null, href: '/documents?tiroir=document:1' },
        { id: 'doc_2', typeLabel: 'Document', title: 'B', subtitle: null, date: null, status: null, excerpt: null, href: '/documents?tiroir=document:2' },
      ] }] },
      { id: 2, result_groups_json: [{ type: 'supplier', label: 'Fournisseurs', total: 1, hasMore: false, moreHref: null, items: [
        { id: 'supplier_4', typeLabel: 'Fournisseur', title: 'C', subtitle: null, date: null, status: null, excerpt: null, href: '/fournisseurs/4' },
      ] }] },
      { id: 3, result_groups_json: null },
    ];
    const out = await dispo.reverifierCartesDesMessages(messages, 7, b.requeteur);
    const cartes = out.flatMap((m) => (m.result_groups_json as Array<{ items: Array<{ id: string; href: string | null; status: string | null }> }> | null ?? []).flatMap((g) => g.items));
    expect(cartes.find((c) => c.id === 'doc_1')?.href).not.toBeNull();
    expect(cartes.find((c) => c.id === 'doc_2')).toMatchObject({ href: null, status: dispo.CARTE_INDISPONIBLE });
    expect(cartes.find((c) => c.id === 'supplier_4')?.href).toBeNull();
    // Une requête par famille pour tout l'historique.
    expect(b.requetes).toHaveLength(2);
  });
});

// ── §19.4 — ordre des sources par contribution ────────────────────────────

describe('§19.4 — sources triées par contribution aux affirmations, puis par score', () => {
  it('la source citée par le plus d’affirmations passe devant une source mieux classée mais non citée', () => {
    const s = [
      { ...resolved('doc_1'), relevanceScore: 0.95 },
      { ...resolved('doc_2'), relevanceScore: 0.6 },
      { ...resolved('doc_3'), relevanceScore: 0.8 },
    ];
    const claims = [
      { claimKey: 'a', text: 'A', sourceIds: ['doc_2'], derivation: 'direct' as const },
      { claimKey: 'b', text: 'B', sourceIds: ['doc_2', 'doc_3'], derivation: 'direct' as const },
    ];
    expect(trierParContribution(s, claims).map((x) => x.id)).toEqual(['doc_2', 'doc_3', 'doc_1']);
    // Sans affirmation : l'ordre du retrieval est conservé.
    expect(trierParContribution(s, []).map((x) => x.id)).toEqual(['doc_1', 'doc_2', 'doc_3']);
  });
});

// ── §19.8 — « Pourquoi ? » : règle, calcul et limites ──────────────────────

describe('§19.8 — « Pourquoi ? » montre la règle ou le calcul, et les limites', () => {
  it('calcul, contradiction et résultats partiels traduits en phrases', () => {
    const d = explanationDetails({ strategy: 'structured.sum_amounts', escalationReasons: ['TIMEOUT:PARTIAL_RESULTS'] }, 'conflicting');
    expect(d.rule).toMatch(/Calcul : somme des montants/);
    expect(d.limits.join(' ')).toMatch(/se contredisent/);
    expect(d.limits.join(' ')).toMatch(/incomplets/);
  });
  it('document en analyse, offre, stratégie inconnue : aucun code brut ne sort', () => {
    const d = explanationDetails({ strategy: 'retrieval.document_status', escalationReasons: ['DOCUMENT:IN_ANALYSIS', 'PLAN_LIMIT:TRIAL_EXPIRED', 'N1:NO_STRUCTURED_PLAN'] }, 'insufficient');
    expect(d.rule).toMatch(/statut d’analyse/);
    expect(d.limits).toHaveLength(3);
    expect(d.limits.join(' ')).not.toMatch(/[A-Z_]{5,}/);
    expect(explanationDetails(null, null)).toEqual({ rule: null, limits: [] });
  });
  it('la route d’explication renvoie `rule` et `limits`', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/verebona/messages/[messageId]/explanation/route.ts'), 'utf-8');
    expect(route).toMatch(/explanationDetails\(/);
    expect(route).toMatch(/rule, limits/);
  });
});

// ── §22.7 — l'offre est vérifiée pour chaque action ───────────────────────

const ACCESS = {
  assetInAccount: async (_a: number, id: number) => id === 3,
  documentInAccount: async () => true,
  agendaItemInAccount: async () => true,
  helpEntryPublished: async () => true,
};

describe('§22.7 — offre contrôlée côté serveur', () => {
  it('dossier Premium refusé en Standard, accepté en Premium ; export brut ouvert à tous', async () => {
    const intents = [{ type: 'OPEN_EXPORT_AREA' as const, targetId: 'asset_3', params: { exportType: 'DOSSIER_VENTE' } }];
    const std = await resolveActions({ accountId: 7, intent: 'EXPORT_HELP', actionIntents: intents, access: ACCESS, planType: 'STANDARD' });
    const prem = await resolveActions({ accountId: 7, intent: 'EXPORT_HELP', actionIntents: intents, access: ACCESS, planType: 'PREMIUM' });
    expect(std).toHaveLength(0);
    expect(prem.map((a) => a.type)).toEqual(['OPEN_EXPORT_AREA']);
    expect(offrePermet('OPEN_EXPORT_AREA', { exportType: 'EXPORT_BRUT' }, 'STANDARD', null)).toBe(true);
  });
  it('compte en lecture seule : aucune action de création', async () => {
    const r = await resolveActions({
      accountId: 7, intent: 'PRODUCT_HELP_HOW_TO', access: ACCESS, planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED',
      actionIntents: [{ type: 'START_ADD_DOCUMENT' }, { type: 'OPEN_HELP' }],
    });
    expect(r.map((a) => a.type)).toEqual(['OPEN_HELP']);
  });
  it('offre nommée inconnue et type de bien non supporté : refusés', async () => {
    const offre = await resolveActions({ accountId: 7, intent: 'PRODUCT_PLAN_LIMIT', access: ACCESS, actionIntents: [{ type: 'OPEN_PRICING', params: { offer: 'GOLD' } }] });
    expect(offre).toHaveLength(0);
    const bien = await resolveActions({ accountId: 7, intent: 'PRODUCT_HELP_HOW_TO', access: ACCESS, actionIntents: [{ type: 'START_ADD_ASSET', params: { assetType: 'FUSEE' } }] });
    expect(bien).toHaveLength(0);
    const ok = await resolveActions({ accountId: 7, intent: 'PRODUCT_HELP_HOW_TO', access: ACCESS, actionIntents: [{ type: 'START_ADD_ASSET', params: { assetType: 'VEHICULE' } }] });
    expect(ok.map((a) => a.type)).toEqual(['START_ADD_ASSET']);
  });
});

// ── §22.11 — version du catalogue d'actions sur le message ────────────────

describe('§22.11 — version du catalogue d’actions écrite sur le message assistant', () => {
  it('colonne `action_catalog_version` alimentée par ACTION_CATALOG_VERSION', () => {
    const service = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/core/conversation.service.ts'), 'utf-8');
    expect(service).toMatch(/result_groups_json, action_catalog_version/);
    expect(service).toMatch(/ACTION_CATALOG_VERSION,/);
    expect(ACTION_CATALOG_VERSION).toBe('action-catalog-v1.2');
  });
});

// ── §13.7 — période et type demandés dans le score ────────────────────────

describe('§13.7 — période et type de document demandés', () => {
  it('périodes explicites et relatives', () => {
    expect(analyserPeriode('mes factures de 2024', TODAY)).toMatchObject({ kind: 'resolved', from: '2024-01-01', to: '2024-12-31' });
    expect(analyserPeriode('le devis de mars 2025', TODAY)).toMatchObject({ from: '2025-03-01', to: '2025-03-31' });
    expect(analyserPeriode('la facture du 12/03/2024', TODAY)).toMatchObject({ from: '2024-03-12', to: '2024-03-12' });
    expect(analyserPeriode("les factures de l'an dernier", TODAY)).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    expect(analyserPeriode('le mois dernier', TODAY)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(analyserPeriode('une facture de 2000 €', TODAY)).toBeNull();
    expect(analyserPeriode('ma facture EDF', TODAY)).toBeNull();
  });
  it('la période sort des termes cherchés ; le type demandé est reconnu', () => {
    const r = analyserRequeteCanonique('Retrouve mes factures EDF de 2024', TODAY);
    expect(r.period).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(r.terms.map((t: { stem: string }) => t.stem)).not.toContain('2024');
    expect(r.documentTypes).toEqual(['facture']);
  });
  it('bonus : dans la période +, hors période −, date inconnue neutre ; type correspondant +', () => {
    const q = { period: { from: '2024-01-01', to: '2024-12-31' } };
    expect(bonusPeriode(q, '2024-06-01')).toBeGreaterThan(0);
    expect(bonusPeriode(q, '2021-06-01')).toBeLessThan(0);
    expect(bonusPeriode(q, null)).toBe(0);
    expect(bonusPeriode({}, '2024-06-01')).toBe(0);
    expect(bonusType({ documentTypes: ['facture'] }, 'FACTURE_TRAVAUX')).toBeGreaterThan(0);
    expect(bonusType({ documentTypes: ['facture'] }, 'DEVIS')).toBe(0);
    expect(dansPeriode('2024-12-31', q.period)).toBe(true);
  });
});

// ── §13.8 — dédoublonnage au-delà de l'identifiant ────────────────────────

const src = (id: string, score: number, meta: Source['meta'] = {}, title = id, type: Source['type'] = 'document'): Source =>
  ({ id, type, title, content: '', relevanceScore: score, meta });

describe('§13.8 — dédoublonnage logique', () => {
  it('même entité par deux chemins, même empreinte, copie, document regroupé', () => {
    const out = dedupeLogique([
      src('doc_12', 0.7),
      src('doc_012', 0.9), // même entité, écrite autrement : la mieux classée remplace
      src('doc_20', 0.8, { contentHash: 'abc' }),
      src('doc_21', 0.8, { contentHash: 'abc', date: '2025-01-01' }), // même contenu, plus récent
      src('doc_30', 0.6, { date: '2024-02-02', size: 1000 }, 'Facture EDF'),
      src('doc_31', 0.6, { date: '2024-02-02', size: 1000 }, 'facture edf'), // copie
      src('doc_40', 0.5, { logicalFileId: 41 }), // source regroupée dans doc_41
      src('doc_41', 0.5, { logicalFileId: 41 }),
      src('asset_3', 0.5, {}, 'Maison', 'asset_field'),
    ]);
    expect(out.map((s) => s.id)).toEqual(['doc_012', 'doc_21', 'doc_30', 'doc_41', 'asset_3']);
  });
});

// ── §11.4 — résultats proches ──────────────────────────────────────────────

describe('§11.4 — résultats proches quand rien n’est trouvé', () => {
  it('motifs tolérants et correspondance approximative', () => {
    const [t] = tokenizeQuery('chaudeire');
    expect(likePatternsTolerants(t).length).toBeGreaterThan(1);
    expect(nearMatchRatio(tokenizeQuery('plombrie'), 'Facture Plomberie Martin')).toBe(1);
    expect(nearMatchRatio(tokenizeQuery('assurance'), 'Facture EDF')).toBe(0);
  });

  it('orchestrateur : 0 résultat → au plus 3 cartes « proches », sans modèle, en Standard et Premium', async () => {
    for (const planType of ['STANDARD', 'PREMIUM']) {
      const generate = vi.fn();
      const r = await runAssistant(
        { accountId: 7, userId: 3, planType, message: 'Retrouve la facture de plombrie', clientRequestId: `n-${planType}`, locale: 'fr-FR' },
        {
          retrieve: async () => [],
          retrieveNear: async () => [src('doc_1', 0.45, {}, 'Facture plomberie Martin'), src('doc_2', 0.4, {}, 'Devis plomberie')],
          resolveSources: async (s) => s as never,
          resolveActions: async () => [],
          persist: async () => null,
          hasPendingClarification: async () => false,
          generateWithAI: generate,
        } as Ports,
      );
      expect(r.answer).toMatch(/Résultats proches : « Facture plomberie Martin » et « Devis plomberie »/);
      expect(r.answer).toMatch(/reformuler/);
      expect(r.resultGroups?.[0].items).toHaveLength(2);
      expect(r.cascade?.strategy).toBe('retrieval.near');
      expect(generate).not.toHaveBeenCalled();
    }
  });
});

// ── §12.1, §12.2 — exports et statut d'un document ────────────────────────

const port = (over: Partial<Port> = {}): Port => ({
  today: () => TODAY,
  findAssets: async () => [],
  listAssets: async () => [],
  countDocuments: async () => 0,
  countAgenda: async () => 4,
  upcomingAgenda: async () => [],
  sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
  searchFacts: async () => [],
  searchDocuments: async () => [],
  ...over,
});

describe('§12.2 — « quel est le statut de ce document ? » en question directe', () => {
  it('routage : statut d’un document ≠ signification d’un statut', () => {
    const r = (message: string, pageContext?: Record<string, string>) =>
      routeDeterministic({ message, planType: 'STANDARD', hasPendingClarification: false, pageContext, today: TODAY });
    const intent = (o: ReturnType<typeof r>) => (o.kind === 'route' ? o.route.intent : 'CLASSIFICATION');
    expect(intent(r('Quel est le statut de ce document ?', { documentId: '5' }))).toBe('ACCOUNT_FACT_DOCUMENT');
    expect(intent(r('Où en est l’analyse de ma facture EDF ?'))).toBe('ACCOUNT_FACT_DOCUMENT');
    expect(intent(r('Que signifie le statut « À vérifier » ?'))).toBe('PRODUCT_HELP_STATUS');
  });

  it('document de la page : statut lu tel quel, sans modèle', async () => {
    const out = await answerFromData({
      port: port({ findDocument: async () => ({ fileId: 5, title: 'Facture EDF', date: '2026-01-10', assetName: 'Maison', matchedTerms: 1, analysisState: 'ANALYZING' }) }),
      accountId: 7, message: 'Quel est le statut de ce document ?', pageDocumentId: 5, thresholds: DEFAULT_THRESHOLDS,
    });
    expect(out.handled).toBe(true);
    expect(out.strategy).toBe('structured.document_status');
    expect(out.answer).toMatch(/Statut de « Facture EDF » : en cours d’analyse/);
    expect(out.claims).toHaveLength(1);
  });

  it('document désigné par ses termes ; plusieurs candidats : le statut de chacun', async () => {
    const un = await answerFromData({
      port: port({ searchDocuments: async () => [{ fileId: 8, title: 'Facture EDF', date: null, assetName: null, matchedTerms: 1, analysisState: 'ANALYZED' }] }),
      accountId: 7, message: 'Où en est l’analyse de ma facture EDF ?', thresholds: DEFAULT_THRESHOLDS,
    });
    expect(un.answer).toBe('Statut de « Facture EDF » : analysé.');
    const deux = await answerFromData({
      port: port({ searchDocuments: async () => [
        { fileId: 8, title: 'Facture EDF janvier', date: null, assetName: null, matchedTerms: 1, analysisState: 'ANALYZED' },
        { fileId: 9, title: 'Facture EDF février', date: null, assetName: null, matchedTerms: 1, analysisState: 'ANALYSIS_FAILED' },
      ] }),
      accountId: 7, message: 'Quel est le statut de ma facture EDF ?', thresholds: DEFAULT_THRESHOLDS,
    });
    expect(deux.answer).toMatch(/Facture EDF janvier/);
    expect(deux.answer).toMatch(/analyse impossible/);
  });
});

describe('§12.1 — exports et dossiers disponibles', () => {
  it('routage : liste des exports = donnée du compte ; « comment exporter » reste de l’aide', () => {
    const intent = (message: string) => {
      const o = routeDeterministic({ message, planType: 'STANDARD', hasPendingClarification: false, today: TODAY });
      return o.kind === 'route' ? o.route.intent : 'CLASSIFICATION';
    };
    expect(intent('Quels exports sont disponibles ?')).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(intent('Mes dossiers générés')).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(intent('Comment exporter un dossier en PDF ?')).toBe('PRODUCT_HELP_HOW_TO');
  });

  it('liste lue dans le compte, avec statut, et lien vers l’onglet Exports du bien', async () => {
    const out = await answerFromData({
      port: port({ listExports: async () => [
        // Code V12 ; un ancien code (ligne antérieure à la migration 0213) a le même libellé.
        { id: 2, assetId: 3, assetName: 'Maison', exportType: 'VENTE', status: 'ready', date: '2026-09-01' },
        { id: 4, assetId: 3, assetName: 'Maison', exportType: 'EXPORT_BRUT', status: 'generating', date: null },
      ] }),
      accountId: 7, message: 'Quels exports sont disponibles ?', thresholds: DEFAULT_THRESHOLDS,
    });
    expect(out.strategy).toBe('structured.exports');
    expect(out.answer).toMatch(/Kit de mise en vente \(Maison\), 1(er)? septembre 2026 : prêt/);
    expect(out.answer).toMatch(/en cours de génération/);
    expect(out.sources[0]).toMatchObject({ id: 'export_2', type: 'export_item' });
    expect(hrefSource('export_2', { assetId: 3 })).toBe('/assets/3?tab=exports');
    expect(hrefSource('export_2')).toBeNull();
  });
});

// ── CA-24 — comptages tracés par une affirmation ──────────────────────────

describe('CA-24 — chaque réponse structurée porte une affirmation', () => {
  it('comptage d’échéances et de biens : claim « calculated »', async () => {
    const agenda = await answerFromData({ port: port(), accountId: 7, message: 'Combien d’échéances à venir ?', thresholds: DEFAULT_THRESHOLDS });
    expect(agenda.strategy).toBe('structured.count_agenda');
    expect(agenda.claims).toEqual([expect.objectContaining({ derivation: 'calculated' })]);
    const biens = await answerFromData({
      port: port({ listAssets: async () => [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false }] }),
      accountId: 7, message: 'Combien de biens ai-je ?', thresholds: DEFAULT_THRESHOLDS,
    });
    expect(biens.strategy).toBe('structured.count_assets');
    expect(biens.claims[0]).toMatchObject({ derivation: 'calculated', sourceIds: ['asset_3'] });
  });
});

// ── §9.2, §14.1 — gabarits déterministes ──────────────────────────────────

describe('§9.2 / §14.1 — intentions produites sans modèle', () => {
  const intent = (message: string) => {
    const o = routeDeterministic({ message, planType: 'STANDARD', hasPendingClarification: false, today: TODAY });
    return o.kind === 'route' ? o.route.intent : 'CLASSIFICATION';
  };
  it.each([
    ['Que comprend mon offre ?', 'PRODUCT_PLAN_LIMIT'],
    ['La synchronisation d’agenda est-elle incluse dans mon offre ?', 'PRODUCT_PLAN_LIMIT'],
    ['Qu’est-ce qui manque sur mes biens ?', 'ACCOUNT_MISSING_INFORMATION'],
    ['Supprime la facture EDF', 'UNSUPPORTED_ACTION'],
    ['L’application plante depuis ce matin', 'TECHNICAL_ISSUE'],
    ['Quelle est la météo demain ?', 'OUT_OF_SCOPE'],
  ])('« %s » → %s', (m, attendu) => { expect(intent(m)).toBe(attendu); });

  it('gabarit d’offre : différent en Standard et en Premium, limite signalée, action « Voir les offres »', () => {
    const std = tryDeterministic('PRODUCT_PLAN_LIMIT', { planType: 'STANDARD' });
    const prem = tryDeterministic('PRODUCT_PLAN_LIMIT', { planType: 'PREMIUM' });
    const echu = tryDeterministic('PRODUCT_PLAN_LIMIT', { planType: 'STANDARD', planLimit: 'TRIAL_EXPIRED' });
    expect(std.answer).toMatch(/offre Standard/);
    expect(prem.answer).toMatch(/fonctions Premium/);
    expect(echu.answer).toMatch(/essai est terminé/);
    expect(std.actionIntents).toEqual([{ type: 'OPEN_PRICING' }]);
  });

  it('orchestrateur : « Que comprend mon offre ? » répond par le gabarit, 0 appel modèle', async () => {
    const classify = vi.fn();
    const r = await runAssistant(
      { accountId: 7, userId: 3, planType: 'STANDARD', message: 'Que comprend mon offre ?', clientRequestId: 'o', locale: 'fr-FR' },
      { retrieve: async () => [], resolveSources: async () => [], resolveActions: async () => [], persist: async () => null, hasPendingClarification: async () => false, classifyWithAI: classify } as Ports,
    );
    expect(r.cascade?.strategy).toBe('template.PRODUCT_PLAN_LIMIT');
    expect(r.answer).toMatch(/offre Standard/);
    expect(classify).not.toHaveBeenCalled();
  });
});

// ── §9.4, §9.5 — contexte de page, indices et clarification ───────────────

describe('§9.4 — le contexte de page oriente le routage', () => {
  const intent = (message: string, pageContext?: Record<string, string>, pageRoute?: string) => {
    const o = routeDeterministic({ message, planType: 'STANDARD', hasPendingClarification: false, pageContext, pageRoute, today: TODAY });
    return o.kind === 'route' ? o.route.intent : 'CLASSIFICATION';
  };
  it('« quel est le montant ? » : donnée du document sur sa page, du bien ailleurs', () => {
    expect(intent('Quel est le montant ?', { documentId: '5' })).toBe('ACCOUNT_FACT_DOCUMENT');
    expect(intent('Quel est le montant ?', undefined, '/documents/5')).toBe('ACCOUNT_FACT_DOCUMENT');
    expect(intent('Quel est le montant ?')).toBe('ACCOUNT_FACT_ASSET');
  });
  it('une question qui désigne l’objet affiché porte sur lui', () => {
    expect(intent('Et sa garantie, elle court jusqu’à ?', { assetId: '3' }, '/assets/3')).not.toBe('CLASSIFICATION');
    expect(intent('Qu’y a-t-il ici ?', undefined, '/fournisseurs')).toBe('ACCOUNT_SEARCH_SUPPLIER');
  });
});

describe('§9.5 — `entityHints` et `clarificationRequired` renseignés', () => {
  it('indices : objet de la page, familles nommées, nom cité', () => {
    const h = entityHintsFor('Retrouve la facture « EDF janvier » de ma maison', { assetId: '3' });
    expect(h).toEqual(expect.arrayContaining([
      { type: 'asset', value: 'page:3' }, { type: 'document', value: 'EDF janvier' },
      { type: 'document', value: 'facture' }, { type: 'asset', value: 'maison' },
    ]));
    const o = routeDeterministic({ message: 'Retrouve la facture de ma maison', planType: 'STANDARD', hasPendingClarification: false, today: TODAY });
    expect(o.kind === 'route' && o.route.entityHints.length).toBeGreaterThan(0);
  });
  it('clarification exigée : période non identifiable, action ambiguë', () => {
    const route = (message: string) => routeDeterministic({ message, planType: 'STANDARD', hasPendingClarification: false, today: TODAY });
    const periode = route('Retrouve mes factures de mars');
    expect(periode.kind === 'route' && periode.route.clarificationRequired).toBe(true);
    const nette = route('Retrouve mes factures de mars 2025');
    expect(nette.kind === 'route' && nette.route.clarificationRequired).toBe(false);
    expect(routeClarificationReason('Ajoute', 'UNKNOWN', TODAY)).toBe('ACTION_AMBIGUOUS');
    expect(routeClarificationReason('Retrouve le devis de l’autre jour', 'ACCOUNT_SEARCH_DOCUMENT', TODAY)).toBe('PERIOD_UNIDENTIFIABLE');
    // L'aide produit n'est pas concernée par la période.
    expect(routeClarificationReason('Comment ajouter un document en mars ?', 'PRODUCT_HELP_HOW_TO', TODAY)).toBeNull();
  });
});

// ── §20.1 — clarification de période et d'action ──────────────────────────

describe('§20.1 — période non identifiable et action ambiguë', () => {
  const commun = { accountId: 7, userId: 3, conversationId: 11, originalMessageId: 'm', chainDepth: 1 };

  it('période : choix construits par le serveur, reprise sur la demande complétée', async () => {
    const p = analyserPeriode('Retrouve mes factures de mars', TODAY);
    expect(p?.kind).toBe('ambiguous');
    if (p?.kind !== 'ambiguous') return;
    const etat = buildPeriodClarification({ ...commun, originalMessage: 'Retrouve mes factures de mars', originalIntent: 'ACCOUNT_SEARCH_DOCUMENT', expression: p.expression, choices: p.choices });
    expect(etat.question).toBe('Sur quelle période ?');
    expect(etat.candidates.map((c) => c.label)).toEqual(['Mars 2026', 'Mars 2025']);
    expect(await candidatToujoursValide(7, etat.candidateType, etat.candidates[1])).toBe(true);
    const reprise = inputDeReprise({ accountId: 7, userId: 3, planType: 'STANDARD', locale: 'fr-FR' }, etat, etat.candidates[1]);
    expect(reprise.message).toBe('Retrouve mes factures de mars 2025');
    expect(reprise.resume?.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    // La demande reprise n'est plus ambiguë.
    expect(analyserPeriode(reprise.message, TODAY)).toMatchObject({ kind: 'resolved', from: '2025-03-01' });
  });

  it('action : « ajoute » → que souhaitez-vous faire ? ; le choix fixe demande et intention', () => {
    const etat = buildActionClarification({ ...commun, originalMessage: 'Ajoute', originalIntent: 'UNKNOWN' })!;
    expect(etat.candidates.map((c) => c.label)).toEqual(['Ajouter un document', 'Créer une échéance', 'Ajouter un bien']);
    const reprise = inputDeReprise({ accountId: 7, userId: 3, planType: 'STANDARD', locale: 'fr-FR' }, etat, etat.candidates[0]);
    expect(reprise.message).toBe('Comment ajouter un document ?');
    expect(reprise.resume?.intent).toBe('PRODUCT_HELP_HOW_TO');
  });

  it('orchestrateur : la clarification est posée AVANT toute recherche', async () => {
    const retrieve = vi.fn(async () => [] as Source[]);
    const saved: unknown[] = [];
    const r = await runAssistant(
      { accountId: 7, userId: 3, planType: 'STANDARD', message: 'Retrouve mes factures de mars', clientRequestId: 'p', locale: 'fr-FR', conversationId: 11 },
      {
        retrieve, resolveSources: async () => [], resolveActions: async () => [], persist: async () => null,
        hasPendingClarification: async () => false,
        saveClarification: async (s) => { saved.push(s); return true; },
      } as Ports,
    );
    expect(r.finalState).toBe('CLARIFYING');
    expect(r.answer).toBe('Sur quelle période ?');
    expect(saved).toHaveLength(1);
    expect(retrieve).not.toHaveBeenCalled();
  });
});

// ── §8.2 — suggestions dérivées de l'état du compte ───────────────────────

describe('§8.2 — suggestions : page > compte > générique', () => {
  const vide = { toProcessPending: 0, deadlinesSoon: 0, documentsInAnalysis: 0, documentsFailed: 0, exportsReady: 0 };
  it('sans état : comportement inchangé', () => {
    expect(suggestionsForRoute('/documents').map((s) => s.id)).toEqual(suggestionsForRoute('/documents', null).map((s) => s.id));
  });
  it('documents en erreur et exports prêts : proposés après les suggestions de la page', () => {
    // Lot 34 : « Quelles échéances arrivent bientôt ? » exige une échéance ;
    // au plus 3 suggestions.
    const s = suggestionsForRoute('/agenda', { state: { ...vide, documentsFailed: 2, exportsReady: 1 } });
    expect(s.map((x) => x.id)).toEqual(['agenda_sync', 'state_failed', 'state_exports']);
    const t = suggestionsForRoute('/agenda', { state: { ...vide, deadlinesSoon: 1, documentsFailed: 2, exportsReady: 1 } });
    expect(t.map((x) => x.id)).toEqual(['agenda_next', 'agenda_sync', 'state_failed']);
  });
  it('rien en attente : aucune suggestion d’état', () => {
    expect(suggestionsForRoute('/agenda', { state: vide }).some((x) => x.id.startsWith('state_'))).toBe(false);
  });
  it('pas de doublon avec la page (accueil : « Quelles échéances arrivent bientôt ? » déjà présent)', () => {
    const labels = suggestionsForRoute('/', { state: { ...vide, toProcessPending: 3, deadlinesSoon: 2 } }).map((x) => x.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ── §10.4 — articles archivés et questions sans réponse ───────────────────

describe('§10.4 — articles archivés filtrés, questions sans réponse remontées', () => {
  const article = (id: string, status?: string, validatedAt: string | null = '2026-09-01') => ({
    id, title: 'Ajouter un document', path: `/aide/${id.toLowerCase()}`, category: 'documents', categoryName: 'Documents',
    summary: 'Déposer un fichier.', offers: ['standard'], offersLabel: 'Toutes', offersNote: null, synonyms: ['déposer'],
    sections: [{ anchor: 'p', heading: 'Procédure', text: 'Ouvrez Documents puis Ajouter un document.' }], ...(status ? { status } : {}),
    ...(validatedAt ? { validatedAt } : {}),
  });
  it('seuls les articles publiés ET validés sont des sources (§10.3, D-O)', () => {
    const c = parseHelpCorpus({ schema: 'verebona-help-t2-v1', version: 'v', environment: 'preprod', articles: [
      article('AID-1'), article('AID-2', 'published'), article('AID-3', 'archived'), article('AID-4', 'draft'),
      article('AID-5', 'published', null), article('AID-6', 'published', '2999-01-01'), article('AID-7', 'published', '01/09/2026'),
    ] })!;
    // Sans statut, sans date, date future ou illisible : jamais une source.
    expect(c.articles.map((a) => a.id)).toEqual(['AID-2']);
    // Double garde : même un corpus non filtré ne fait pas remonter l'archivé.
    const brut = { schema: 'verebona-help-t2-v1' as const, version: 'v', environment: 'preprod', articles: [article('AID-3', 'archived')] };
    expect(searchHelpCorpus(brut, 'ajouter un document')).toHaveLength(0);
  });
  it('questions sans article : expurgées, regroupées par intention et formulation', () => {
    const q = agregerQuestions([
      { intent: 'PRODUCT_HELP_HOW_TO', content: 'Comment lier ma carte 4970 1234 5678 9012 ?', created_at: '2026-09-01T10:00:00Z' },
      { intent: 'PRODUCT_HELP_HOW_TO', content: 'comment lier ma carte 4970123456789012', created_at: '2026-09-02T10:00:00Z' },
      { intent: 'NAVIGATION_FIND', content: 'Où régler les écrans ? jean@exemple.fr', created_at: '2026-09-03T10:00:00Z' },
    ]);
    expect(q[0]).toMatchObject({ intent: 'PRODUCT_HELP_HOW_TO', count: 2, lastSeen: '2026-09-02T10:00:00.000Z' });
    expect(JSON.stringify(q)).not.toMatch(/4970|jean@/);
    expect(expurgerQuestion('Contrat 123456789')).toBe('Contrat [numéro]');
  });

  it.each([
    ['Comment ajouter la facture de M. Dupont ?', 'Comment ajouter la facture de M. [nom] ?', /Dupont/],
    ['Madame Anne-Marie Le Gall ne voit pas ses documents', 'Madame [nom] ne voit pas ses documents', /Anne|Gall/],
    ['Dr Martin et Maître Durand : comment partager ?', 'Dr [nom] et Maître [nom] : comment partager ?', /Martin|Durand/],
    ['Comment changer l’adresse 12 bis rue des Lilas ?', 'Comment changer l’adresse [adresse] ?', /Lilas/],
    ['Mon bien au 3, avenue Victor Hugo n’apparaît pas', 'Mon bien au [adresse] n’apparaît pas', /Victor|Hugo/],
    ['où est le devis du 12/03/2024 et du 05-06 ?', 'où est le devis du [date] et du [date] ?', /12\/03|05-06/],
    ['je suis à 69003 Lyon', 'je suis à [code postal] Lyon', /69003/],
  ])('expurgation : « %s »', (entree, attendu, interdit) => {
    const out = expurgerQuestion(entree);
    expect(out).toBe(attendu);
    expect(out).not.toMatch(interdit);
  });

  it('expurgation : pas de faux positif sur une taille ou une question ordinaire', () => {
    expect(expurgerQuestion('Le fichier fait 2.5 Mo, est-ce trop ?')).toBe('Le fichier fait 2.5 Mo, est-ce trop ?');
    expect(expurgerQuestion('Comment ajouter un document ?')).toBe('Comment ajouter un document ?');
  });

  it('seules les questions encore conservées remontent (message et fil non expirés, fil actif) ; index 0205', () => {
    const repo = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/core/unanswered-help.repository.ts'), 'utf-8');
    expect(repo).toMatch(/m\.expires_at > now\(\)/);
    expect(repo).toMatch(/c\.status = 'active' AND c\.expires_at > now\(\)/);
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0205_verebona_messages_request_idx.sql'), 'utf-8');
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS verebona_messages_user_request_idx\s+ON verebona_messages \(request_id\)\s+WHERE role = 'user'/);
  });
});
