/**
 * Lot 49 — ticket 7 : les actions T2 suivent la MÊME règle de disponibilité
 * des biens que la résolution T2 (`assistantAssetAvailability`).
 *
 * Base simulée en mémoire : la requête n'applique la règle complète que si
 * elle porte EXACTEMENT la condition centralisée (sinon seul `deleted_at`
 * filtrerait, comme avant le correctif) — le test échoue donc si le contrôle
 * d'accès revient à une copie locale ou à `deleted_at IS NULL` seul.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Bien = { id: number; account: number; name: string; status: string | null; deleted: boolean };
let BIENS: Bien[] = [];
const sqls: string[] = [];

const avail = await import('../../asset-availability');
const REGLE = avail.assistantAssetAvailability.sql('a');

function filtre(sql: string, b: Bien): boolean {
  if (sql.includes(REGLE)) return avail.isAssetAvailableForAssistant({ status: b.status, deletedAt: b.deleted ? new Date() : null });
  if (/deleted_at IS NULL/.test(sql)) return !b.deleted;
  return true;
}

const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
  sqls.push(sql);
  if (/FROM assets a WHERE a\.id = \$1 AND a\.account_id = \$2/.test(sql) || /FROM assets WHERE id = \$1 AND account_id = \$2/.test(sql)) {
    const [id, acc] = params as [number, number];
    return BIENS.filter((b) => b.id === Number(id) && b.account === Number(acc) && filtre(sql, b)).map(() => ({ '?column?': 1 }));
  }
  if (/SELECT a?\.?id, a?\.?name FROM assets/.test(sql)) {
    const [acc, ids] = params as [number, number[]];
    return BIENS.filter((b) => b.account === Number(acc) && ids.map(Number).includes(b.id) && filtre(sql, b)).map((b) => ({ id: b.id, name: b.name }));
  }
  return [];
});
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p?: unknown[]) => unsafe(s, p) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const { buildOrchestratorPorts, buildAccessChecker, revalidateActionTargets } = await import('../../ports');
const { routeForIntent } = await import('../../intent-router.service');
type Input = import('../../../types/contracts').AssistantRequestInput;
type Source = import('../../../types/sources').RetrievedSource;

const ports = buildOrchestratorPorts();
const input = (message: string, extra: Partial<Input> = {}): Input =>
  ({ accountId: 7, userId: 3, planType: 'PREMIUM', message, clientRequestId: 'c', locale: 'fr-FR', ...extra });
const sourceBien = (id: number): Source => ({ id: `asset_${id}`, type: 'asset_field', title: 'Bien', content: '', relevanceScore: 1, meta: { assetId: id } });

/** Toutes les actions produites pour un bien de page, sur les intentions qui proposent les quatre actions ciblées. */
async function actionsPourPage(assetId: number) {
  const page = { assetId: String(assetId), route: `/assets/${assetId}` };
  const cas: Array<[string, Parameters<typeof routeForIntent>[0], Source[]]> = [
    ['Que manque-t-il ?', 'ACCOUNT_MISSING_INFORMATION', [sourceBien(assetId)]],
    ['Comment exporter ?', 'EXPORT_HELP', []],
    ['Comment ajouter un document ?', 'PRODUCT_HELP_HOW_TO', []],
    ['Comment créer une échéance ?', 'PRODUCT_HELP_HOW_TO', []],
    ['Ouvre le bien', 'NAVIGATION_OPEN', [sourceBien(assetId)]],
  ];
  const out = [];
  for (const [m, intent, sources] of cas) {
    out.push(...await ports.resolveActions(routeForIntent(intent, 'PREMIUM', 't'), input(m, { pageContext: page }), sources));
  }
  return out;
}
const CIBLEES = ['START_ADD_DOCUMENT', 'START_ADD_AGENDA_ITEM', 'OPEN_EXPORT_AREA', 'OPEN_ASSET'];

beforeEach(() => { sqls.length = 0; unsafe.mockClear(); });

describe('Lot 49 ticket 7 — actions T2 et disponibilité des biens', () => {
  it('T2ACT-AC01 — bien EN_SERVICE : les actions ciblées restent disponibles', async () => {
    BIENS = [{ id: 42, account: 7, name: 'Polo', status: 'EN_SERVICE', deleted: false }];
    const a = await actionsPourPage(42);
    const types = new Set(a.filter((x) => x.targetRef === 'asset:42').map((x) => x.type));
    for (const t of CIBLEES) expect(types.has(t as never)).toBe(true);
  });

  it.each([
    ['T2ACT-AC02', 'ARCHIVED', false],
    ['T2ACT-AC03', 'TRANSMIS', false],
    ['T2ACT-AC04', 'VENDU', false],
    ['T2ACT-AC05', 'EN_SERVICE', true],
  ])('%s — bien de page %s (supprimé : %s) : aucune action ciblée sur ce bien', async (_ac, status, deleted) => {
    BIENS = [{ id: 42, account: 7, name: 'Polo', status, deleted }];
    const a = await actionsPourPage(42);
    expect(a.filter((x) => x.targetRef === 'asset:42')).toEqual([]);
    expect(a.some((x) => CIBLEES.includes(x.type) && x.targetRef != null)).toBe(false);
    // L'aide produit reste proposée, SANS bien présélectionné.
    const ajout = a.find((x) => x.type === 'START_ADD_DOCUMENT');
    expect(ajout?.targetRef ?? null).toBeNull();
  });

  it('T2ACT-AC02b — reprise de clarification ou référence du fil vers un bien archivé : retirées avant les actions', async () => {
    BIENS = [{ id: 42, account: 7, name: 'Polo', status: 'ARCHIVED', deleted: false }, { id: 5, account: 7, name: 'Clio', status: null, deleted: false }];
    const access = buildAccessChecker();
    const r = await revalidateActionTargets(input('x', {
      pageContext: { assetId: '5', route: '/assets/5' },
      resume: { clarificationId: 'c', intent: 'ACCOUNT_FACT_ASSET', assetId: 42, chainDepth: 0, choiceLabel: 'Polo' },
      reference: { type: 'asset', id: 42, method: 'thread' },
    }), access);
    expect(r.pageContext?.assetId).toBe('5');
    expect(r.resume?.assetId ?? null).toBeNull();
    expect(r.reference).toBeUndefined();
  });

  it('T2ACT-AC06 — assetNames() : bien actif + bien archivé → seul le nom du bien actif', async () => {
    BIENS = [
      { id: 1, account: 7, name: 'Maison', status: 'EN_SERVICE', deleted: false },
      { id: 2, account: 7, name: 'Ancienne maison', status: 'ARCHIVED', deleted: false },
      { id: 3, account: 7, name: 'Polo vendue', status: 'VENDU', deleted: false },
      { id: 4, account: 7, name: 'Supprimé', status: null, deleted: true },
    ];
    const noms = await buildAccessChecker().assetNames!(7, [1, 2, 3, 4]);
    expect([...noms.entries()]).toEqual([[1, 'Maison']]);
    // Libellés « Ouvrir « … » » : un bien indisponible n'est pas réintroduit.
    const a = await ports.resolveActions(routeForIntent('ACCOUNT_SEARCH_ASSET', 'PREMIUM', 't'), input('mes biens'), [sourceBien(1), sourceBien(2)]);
    expect(a.filter((x) => x.type === 'OPEN_ASSET').map((x) => x.targetRef)).toEqual(['asset:1']);
  });

  it('T2ACT-AC07 — cohérence globale : assetInAccount et assetNames portent la règle centralisée, pas une copie', async () => {
    BIENS = [{ id: 1, account: 7, name: 'Maison', status: null, deleted: false }];
    const access = buildAccessChecker();
    await access.assetInAccount(7, 1);
    await access.assetNames!(7, [1]);
    expect(sqls).toHaveLength(2);
    for (const s of sqls) expect(s).toContain(REGLE);
    // Aucune condition de statut recopiée ni « deleted_at IS NULL » seul sur
    // les biens dans le vérificateur d'accès.
    const src = readFileSync(join(process.cwd(), 'src/services/verebona-assistant/core/ports.ts'), 'utf8');
    const checker = src.slice(src.indexOf('export function buildAccessChecker'), src.indexOf('export function construireActionIntents'));
    expect(checker).not.toMatch(/FROM assets[^`]*deleted_at IS NULL/);
    expect(checker).not.toMatch(/ARCHIVED|TRANSMIS|VENDU/);
    expect(checker.match(/assistantAssetAvailability\.sql\('a'\)/g)).toHaveLength(2);
    // Même règle que la résolution T2 (findAssets / listAssets).
    expect(avail.assistantAssetAvailability.sql('a')).toBe(REGLE);
  });

  it('T2ACT-AC08 — compte étranger : bien d’un autre compte refusé comme avant', async () => {
    BIENS = [{ id: 42, account: 8, name: 'Polo', status: 'EN_SERVICE', deleted: false }];
    expect(await buildAccessChecker().assetInAccount(7, 42)).toBe(false);
    const a = await actionsPourPage(42);
    expect(a.filter((x) => x.targetRef === 'asset:42')).toEqual([]);
  });
});
