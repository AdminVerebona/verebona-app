/**
 * Carte #849 (complément, A2) — INVENTAIRE des écritures sur un bien : toute
 * route d'écriture (POST / PUT / PATCH / DELETE) passe par une garde « bien
 * TRANSMIS = consultation seule », ou figure dans la liste FERMÉE des
 * exemptions (motif écrit). Une nouvelle route d'écriture sans garde ni
 * motif fait échouer ce test. Les primitives partagées (façade des
 * Opérations, écriture d'Agenda, T1, T3) portent la garde centrale.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const ROOT = process.cwd();
const API = join(ROOT, 'src/app/api');
const lire = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (n === 'route.ts') out.push(p);
  }
  return out;
}

/** Gardes reconnues (route) : centrale, ou historiques déjà sûres sur le statut du bien. */
const GARDES = /refuserSiRequeteSurBienTransmis\(|refuserSiModificationBiensSuspendue\([^)]*,\s*[a-zA-Z.]+\)|refuserSiBienEnLectureSeule\(|refuserSiDocumentDeBienTransmis\(|refuserEcritureAgendaBienTransmis\(|isReadOnlyAssetStatus\(/;

/** Préfixes EXEMPTÉS (aucune écriture sur un bien, ou écriture permise sur un bien transmis), motif écrit. */
const EXEMPTIONS: ReadonlyArray<[RegExp, string]> = [
  [/^admin\//, 'back-office : hors parcours utilisateur (droits ADMIN, journalisé)'],
  [/^(auth|users|account|accounts|me|duo|duos|billing|referral|withdrawal|legal|notifications?|notification-preferences|public|webhooks|cron|mobile\/push-installations|analytics|contact)\//, 'compte, identité, facturation, préférences : aucune donnée d’un bien'],
  [/^mobile\/share-import\//, 'dépôt partagé depuis le mobile : document SANS bien (rattachement ensuite, gardé)'],
  [/^home\/mascot\//, 'mascotte : préférences et suivi de la mascotte du compte'],
  [/^verebona\//, 'Assistant : les exécuteurs passent par les façades gardées (plan.service, executors, operation-write.facade, writeAgendaItem)'],
  [/^export-generations\//, 'export : lecture permise sur un bien transmis'],
  [/^assets\/\[id\]\/exports(\/|$)/, 'export : permis sur un bien transmis (A2 « exports accessibles »)'],
  [/^assets\/\[id\]\/reactivate\//, '« Remettre en service » : seule écriture permise avec la suppression'],
  [/^assets\/\[id\]\/delete-request\//, 'demande de suppression (Duo) : suppression définitive permise'],
  [/^delete-requests\//, 'réponse à une demande de suppression : suppression définitive permise'],
  [/^assets\/\[id\]\/transmission\//, 'transmission = export vers un autre compte ; la bascule du statut est sans effet sur un bien déjà transmis'],
  [/^transmission\//, 'acceptation d’une transmission : écrit chez le DESTINATAIRE (copie indépendante)'],
  [/^suppliers\/(route\.ts|\[id\]\/route\.ts|\[id\]\/archive\/)/, 'fiche fournisseur du compte : pas une donnée d’un bien'],
  [/^to-process\/(conficts|suppliers)\//, 'arbitrages de fiches fournisseurs : pas une donnée d’un bien'],
  [/^agenda\/\[id\]\/statut\//, 'route retirée (410), aucune écriture'],
  [/^documents\/\[id\]\/notify-analyzed\//, 'aucune écriture (202)'],
  [/^documents\/analyze-launch-reports\//, 'journal technique des lancements (aucune donnée d’un bien)'],
  [/^documents\/route\.ts$/, 'DELETE collection : 405, aucune écriture'],
];

const ECRITURE = /^export (?:async function|const) (?:POST|PUT|PATCH|DELETE)\b/m;

describe('#849 (complément) — inventaire des routes d’écriture', () => {
  const toutes = routes(API).filter((f) => ECRITURE.test(readFileSync(f, 'utf8')));
  const rel = (f: string) => relative(API, f).replace(/\\/g, '/');

  it('chaque route d’écriture est GARDÉE (bien transmis) ou EXEMPTÉE avec motif', () => {
    const orphelines = toutes.filter((f) => !GARDES.test(readFileSync(f, 'utf8')) && !EXEMPTIONS.some(([re]) => re.test(rel(f))));
    expect(orphelines.map(rel)).toEqual([]);
    expect(toutes.length).toBeGreaterThan(100);
  });

  it('aucune exemption morte : chaque motif couvre au moins une route', () => {
    for (const [re, motif] of EXEMPTIONS) expect(toutes.some((f) => re.test(rel(f))), motif).toBe(true);
  });

  it('familles clés : documents, Opérations, Agenda, pièces, équipements, TCO, Duo, dépôt — gardées', () => {
    for (const f of [
      'documents/[id]/route.ts', 'documents/[id]/analyze/route.ts', 'documents/[id]/targets/route.ts', 'documents/bulk-move/route.ts',
      'evenements-reference/[id]/route.ts', 'evenements-reference/[id]/documents/route.ts', 'agenda/route.ts', 'agenda/[id]/route.ts',
      'agenda/[id]/liens/route.ts', 'substructures/[id]/equipments/route.ts', 'equipments/[id]/auto-link/route.ts',
      'assets/[id]/tco/decisions/route.ts', 'assets/[id]/move-to-space/route.ts', 'files/presign/route.ts', 'files/confirm/route.ts',
      'web-links/route.ts', 'v2/to-process/[publicId]/resolve/route.ts', 'deadlines/route.ts',
    ]) expect(lire(`src/app/api/${f}`), f).toMatch(GARDES);
  });
});

describe('#849 (complément) — primitives partagées et traitements automatiques', () => {
  it('façade des Opérations : garde centrale avant toute commande (utilisateur, Assistant, T3, T4, système)', () => {
    const src = lire('src/services/business-operations/operation-write.facade.ts');
    const corps = src.slice(src.indexOf('async function runCommand'));
    expect(corps.indexOf('uneCibleEnLectureSeule(accountId, readOnlyTargetsOf(input))')).toBeGreaterThan(-1);
    expect(corps.indexOf('uneCibleEnLectureSeule')).toBeLessThan(corps.indexOf('withGroupingWrite(accountId'));
    expect(corps).toMatch(/refused\('FORBIDDEN', 'ASSET_READ_ONLY'\)/);
  });
  it('écriture d’Agenda (manuelle, T4, projection) : abstention sur un bien transmis, cession seule exceptée', () => {
    expect(lire('src/services/agenda/write-agenda-item.ts')).toMatch(/if \(!opts\.allowTransmittedAsset\) \{[\s\S]*uneCibleEnLectureSeule/);
    const proj = lire('src/services/business-operations/agenda-projection/service.ts');
    expect(proj.match(/allowTransmittedAsset: op\.typeCode === 'DISPOSAL'/g)?.length).toBe(3);
    expect(lire('src/services/agenda/write-agenda-item.ts').match(/allowTransmittedAsset/g)?.length).toBe(2);
  });
  it('T1 : abstention journalisée avant l’analyse ; T3 : aucune création ni aucun enrichissement (sauf cession de la fiche)', () => {
    const t1 = lire('src/services/ai/source-analysis/queue/t1-handler.ts');
    expect(t1.indexOf("abstentionSiLectureSeule(job.accountId, { kind: 'document', id: fileId }, 'T1')")).toBeGreaterThan(-1);
    expect(t1.indexOf('abstentionSiLectureSeule')).toBeLessThan(t1.indexOf('analyzeFileSources([fileId]'));
    expect(lire('src/services/business-operations/consolidation/matching.ts')).toMatch(/!ctx\.fromAssetData && c\.type !== 'DISPOSAL' && c\.assetIds\.length > 0[\s\S]{0,120}'TARGET_OUT_OF_PORTFOLIO'/);
    expect(lire('src/services/business-operations/consolidation/asset-data-consolidator.ts')).toContain('fromAssetData: true');
  });
});

describe('#849 (complément) — cibles d’une commande d’Opération (pure)', async () => {
  const { readOnlyTargetsOf } = await import('@/services/business-operations/operation-write.facade');
  it('opérations, document, élément d’Agenda, biens', () => {
    expect(readOnlyTargetsOf({ operationId: 4, fileId: 9, agendaItemId: '7', assetIds: [1, 2], ignore: 3 })).toEqual([
      { kind: 'operation', id: 4 }, { kind: 'document', id: 9 }, { kind: 'agenda', id: 7 }, { kind: 'asset', id: 1 }, { kind: 'asset', id: 2 },
    ]);
    expect(readOnlyTargetsOf({ fromOperationId: 1, toOperationId: 2 }).map((t) => t.id)).toEqual([1, 2]);
    expect(readOnlyTargetsOf(null)).toEqual([]);
  });
});
