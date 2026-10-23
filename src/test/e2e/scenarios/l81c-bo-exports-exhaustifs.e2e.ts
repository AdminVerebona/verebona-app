/**
 * Lot 81C — BO : plafonds d'extraction supprimés, exports exhaustifs, sur
 * PostgreSQL 16 réel, PAR LES VRAIES ROUTES (garde `requireAdmin` réelle :
 * seule la lecture du cookie de session est simulée).
 *
 * RÉFÉRENCE ROUGE (avant correctif, reproduite) : 17 938 décisions T3 sur un
 * bien → 2 000 extraites par « Données du compte » (SECTION_LIMIT) et 500 par
 * le diagnostic (DIAG_LIMITS.dossierSectionRows).
 *
 *   · L81C-E01 (test 1) T3 : 17 938 décisions retrouvées, consultées
 *     (pagination jusqu'à la plus ancienne, recherche serveur), exportées
 *     (JSON du tiroir et ZIP du diagnostic), sans doublon ni omission,
 *     provenance conservée, statut COMPLETE ;
 *   · L81C-E02 (test 2) volumétrie : 2 001, 10 000, 50 000 lignes, et
 *     exactement 1 et 2 tailles de lot (500, 1 000) — complétude, lots,
 *     pagination, mesure mémoire ;
 *   · L81C-E03 (test 3) relations : 2 100 équipements, 2 100 documents,
 *     2 050 Opérations d'un bien — périmètre et relations exhaustifs ;
 *   · L81C-E04 (test 4) Opérations et TCO : sources, historique, composantes
 *     au-delà des anciennes bornes ; 450 lignes TCO toutes tracées ;
 *   · L81C-E05 (test 5) JSON / CSV / TXT / ZIP : mêmes lignes, mêmes
 *     comptes, manifeste conforme, intégrité (SHA-256) ;
 *   · L81C-E06 (test 6) interruption, délai SQL, échec d'archive, reprise,
 *     écritures concurrentes, client parti : jamais COMPLETE si des données
 *     manquent ;
 *   · L81C-E07 (test 7) sécurité : droits, intercomptes, masquage, lecture
 *     seule (empreintes), suivi des générations réservé aux administrateurs.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

type Json = Record<string, unknown>;
type Section = { id: string; table?: { rows: Json[]; total: number | null; complete: boolean; columns: string[] }; relations?: Json[]; window?: Json; extraction?: Json };

scenario('L81C', 'BO exports exhaustifs : 17 938 décisions T3, pagination, ZIP en flux, complétude', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });
  async function seConnecter(role: 'ADMIN' | 'USER') {
    const u = await make.user({ role });
    session.userId = u.id; session.role = role; session.email = u.email;
    return u;
  }
  let NextRequest: typeof import('next/server').NextRequest;
  let entityGET: (r: import('next/server').NextRequest, c: { params: Promise<{ id: string; type: string; entityId: string }> }) => Promise<Response>;
  let diagGET: (r: import('next/server').NextRequest) => Promise<Response>;
  let gensGET: (r: import('next/server').NextRequest) => Promise<Response>;
  const entity = (accountId: number, type: string, id: number, qs = '') =>
    entityGET(new NextRequest(`http://app.test/api/admin/accounts/${accountId}/entities/${type}/${id}${qs ? `?${qs}` : ''}`), { params: Promise.resolve({ id: String(accountId), type, entityId: String(id) }) });
  const diag = (qs: string) => diagGET(new NextRequest(`http://app.test/api/admin/diagnostics?${qs}`));
  async function exportJson(accountId: number, type: string, id: number, qs = 'format=json') {
    const res = await entity(accountId, type, id, qs);
    expect(res.status, 'export').toBe(200);
    return JSON.parse(await res.text()) as { sections: Section[]; export: Json; exportStatus: string; complete: boolean; warnings: string[]; operationDetail?: Json };
  }
  async function zip(qs: string) {
    const res = await diag(`${qs}&format=zip`);
    expect(res.status, await res.clone().text().catch(() => '')).toBe(200);
    const raw = Buffer.from(await res.arrayBuffer());
    const z = await JSZip.loadAsync(raw);
    const files: Record<string, string> = {};
    for (const [name, f] of Object.entries(z.files)) if (!f.dir) files[name] = await f.async('string');
    for (const [name, c] of Object.entries(files)) if (name.endsWith('.json')) expect(() => JSON.parse(c), name).not.toThrow();
    return { files, headers: res.headers, bytes: raw.length };
  }
  const sec = (d: { sections: Section[] }, id: string) => d.sections.find((s) => s.id === id)!;

  let A: AccountRow;
  let B: AccountRow;
  const ids: Record<string, number> = {};
  const N_T3 = 17_938;
  const VOL: Record<string, number> = { v2001: 2_001, v10000: 10_000, v50000: 50_000, v500: 500, v1000: 1_000 };

  /** Bien et ses `n` décisions T3 (passage de réconciliation, provenance : preuves, règle, confiance, horodatage croissant). */
  async function bienAvecDecisions(account: AccountRow, name: string, n: number): Promise<number> {
    const asset = (await make.asset(account, { category: 'IMMOBILIER', name })).id;
    const run = (await sql<{ id: number }[]>`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status) VALUES (${account.id}, ${asset}, 'scheduled', 'completed') RETURNING id`)[0].id;
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids, source_priority, created_at)
              SELECT ${run}, ${account.id}, ${asset}, 'champ_' || (g % 40), (ARRAY['apply','update','keep','create_conflict','request_ai_review','ignore'])[1 + g % 6],
                     'R' || g, (ARRAY['certain','probable','conflictual'])[1 + g % 3], g % 7 <> 0, jsonb_build_array(g, g + 1, g + 2), g % 5,
                     timestamptz '2024-01-01' + (g || ' minutes')::interval
                FROM generate_series(1, ${n}) g`;
    return asset;
  }

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    entityGET = (await import('@/app/api/admin/accounts/[id]/entities/[type]/[entityId]/route')).GET as never;
    diagGET = (await import('@/app/api/admin/diagnostics/route')).GET as never;
    gensGET = (await import('@/app/api/admin/diagnostics/generations/route')).GET as never;

    A = await make.account({ plan: 'premium', name: 'Compte volumineux L81C' });
    B = await make.account({ plan: 'premium', name: 'Compte etranger L81C' });
    ids.t3 = await bienAvecDecisions(A, 'Maison T3 L81C', N_T3);
    for (const [k, n] of Object.entries(VOL)) ids[k] = await bienAvecDecisions(A, `Bien ${k} L81C`, n);
    // Donnée sensible sur le bien T3 (masquage dans les exports).
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ address1: '9 impasse Secrète L81C', address1__origin: 'USER' })}::jsonb WHERE id = ${ids.t3}`;

    // Relations : 2 100 équipements, 2 100 documents, 2 050 Opérations.
    ids.rel = (await make.asset(A, { category: 'IMMOBILIER', name: 'Bien relations L81C' })).id;
    await sql`INSERT INTO equipments (asset_id, name) SELECT ${ids.rel}, 'Eq ' || g FROM generate_series(1, 2100) g`;
    await sql`INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type) SELECT ${A.ownerUserId}, ${A.id}, ${ids.rel}, 'e2e/' || ${A.id} || '/rel-' || g || '.pdf', 'application/pdf' FROM generate_series(1, 2100) g`;
    const ops = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label)
      SELECT ${A.id}, 'INTERVENTION', 'REALIZED', 'Op rel ' || g FROM generate_series(1, 2050) g RETURNING id::int AS id`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority)
              SELECT ${A.id}, x, ${ids.rel}, 'PRIMARY', 'STRUCTURED' FROM unnest(${ops.map((o) => o.id)}::bigint[]) x`;

    // Opération très sourcée (260 sources, 600 événements) et bien TCO (450 composantes).
    ids.tco = (await make.asset(A, { category: 'IMMOBILIER', name: 'Bien TCO L81C' })).id;
    ids.op = (await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date)
      VALUES (${A.id}, 'INTERVENTION', 'REALIZED', 'Entretiens multiples L81C', 'Prestataire', '2025-06-01') RETURNING id::int AS id`)[0].id;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${A.id}, ${ids.op}, ${ids.tco}, 'PRIMARY', 'STRUCTURED')`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority)
              SELECT ${A.id}, ${ids.op}, 'MIGRATION', 'm-' || g, 'STRUCTURED' FROM generate_series(1, 260) g`;
    await sql`INSERT INTO business_operation_history (account_id, operation_id, event_type, reason_code, correlation_id, created_at)
              SELECT ${A.id}, ${ids.op}, 'FINANCIAL_CHANGED', 'L81C_' || g, 'corr-' || g, now() - (g || ' seconds')::interval FROM generate_series(1, 600) g`;
    await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, label)
              SELECT ${A.id}, ${ids.op}, 'REALIZED_COST', 1000 + g, 'EUR', 'Passage ' || g FROM generate_series(1, 450) g`;

    // Compte B : un bien (isolation).
    ids.assetB = await bienAvecDecisions(B, 'Bien etranger L81C', 3);
  });

  /** Empreinte des tables métier des comptes de test (aucune écriture attendue). */
  async function empreinte(): Promise<string> {
    const acc = `account_id IN (${A.id}, ${B.id})`;
    const out: string[] = [];
    for (const [t, w] of [['assets', acc], ['reconciliation_decisions', acc], ['reconciliation_runs', acc], ['asset_files', acc], ['business_operations', acc],
      ['business_operation_sources', acc], ['business_operation_history', acc], ['business_operation_financial_components', acc], ['business_operation_asset_links', acc]] as const) {
      const [r] = await sql.unsafe(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x WHERE ${w}`);
      out.push(`${t}=${r.n}:${r.h}`);
    }
    return out.join('\n');
  }
  let avant = '';
  it('(empreinte initiale)', async () => { avant = await empreinte(); });

  it('L81C-E01 test 1 — 17 938 décisions T3 : consultées, exportées, sans doublon ni omission, provenance conservée, COMPLETE', async () => {
    await seConnecter('ADMIN');
    const base = await sql<{ id: number; run_id: number; reason_code: string; evidence_ids: unknown; created_at: Date }[]>`
      SELECT id, run_id, reason_code, evidence_ids, created_at FROM reconciliation_decisions WHERE asset_id = ${ids.t3} ORDER BY id`;
    expect(base).toHaveLength(N_T3);
    const oldest = base[0];

    // Consultation (tiroir) : total réel, page, navigation jusqu'à la dernière page (la plus ancienne décision).
    const tiroir = await (await entity(A.id, 'asset', ids.t3)).json() as { sections: Section[]; complete: boolean };
    expect(sec(tiroir, 'reco-decisions').window).toMatchObject({ total: N_T3, offset: 0, size: 50 });
    expect(sec(tiroir, 'reco-decisions').table!.rows).toHaveLength(50);
    expect(tiroir.complete).toBe(true);
    const last = await (await entity(A.id, 'asset', ids.t3, `section=reco-decisions&offset=${N_T3 - 38}&size=50`)).json() as { section: Section };
    expect(last.section.table!.rows).toHaveLength(38);
    expect(last.section.table!.rows.at(-1)).toMatchObject({ id: oldest.id, reason_code: 'R1' });
    // Recherche SERVEUR sur toutes les lignes (pas seulement la page chargée).
    const found = await (await entity(A.id, 'asset', ids.t3, 'section=reco-decisions&q=%22R17%22')).json() as { section: Section };
    expect(found.section.window).toMatchObject({ total: N_T3, matched: 1, query: '"R17"' });
    expect(found.section.table!.rows[0]).toMatchObject({ reason_code: 'R17' });

    // Export JSON intégral (route, en flux).
    const d = await exportJson(A.id, 'asset', ids.t3);
    const t = sec(d, 'reco-decisions');
    const got = t.table!.rows.map((r) => Number(r.id));
    expect(got).toHaveLength(N_T3);
    expect(new Set(got).size).toBe(N_T3);                                  // aucun doublon
    expect([...got].sort((a, b) => a - b)).toEqual(base.map((r) => r.id));  // aucune omission
    expect(t.table!.rows.at(-1)).toMatchObject({ id: oldest.id, run_id: oldest.run_id, reason_code: 'R1', evidence_ids: [1, 2, 3] }); // la plus ancienne, provenance
    expect(t.extraction).toMatchObject({ expected: N_T3, exported: N_T3, batches: Math.ceil(N_T3 / 500), status: 'COMPLETE', error: null });
    expect(d).toMatchObject({ complete: true, exportStatus: 'COMPLETE', export: { status: 'COMPLETE', snapshot: { isolation: 'REPEATABLE READ, READ ONLY' } } });
    expect(JSON.stringify(d)).not.toContain('9 impasse Secrète L81C');

    // Diagnostic technique ZIP (périmètre bien) : même exhaustivité.
    const z = await zip(`scope=asset&id=${ids.t3}`);
    const dossier = JSON.parse(z.files[`metier/bien-${ids.t3}.json`]) as { sections: Section[] };
    const zrows = sec(dossier, 'reco-decisions').table!.rows.map((r) => Number(r.id));
    expect(new Set(zrows).size).toBe(N_T3);
    expect(zrows).toHaveLength(N_T3);
    const m = JSON.parse(z.files['manifeste.json']) as Json & { files: Array<Json & { path: string }> };
    expect(m).toMatchObject({ status: 'COMPLETE', snapshot: { isolation: 'REPEATABLE READ, READ ONLY' } });
    expect(m.files.find((f) => f.path === `metier/bien-${ids.t3}.json`)).toMatchObject({ status: 'COMPLETE', complete: true });
    expect(z.files['rapport.txt']).toContain('Statut           : COMPLETE');
    // Consultation (aperçu) « tout l'historique disponible » : statut et décomptes de chaque fichier, sans borne de période.
    const v = await (await diag(`scope=asset&id=${ids.t3}&period=all`)).json() as { manifest: Json & { files: Array<Json & { path: string }> }; report: string };
    expect(v.manifest).toMatchObject({ status: 'COMPLETE', request: { from: null } });
    expect(Number(v.manifest.files.find((f) => f.path === `metier/bien-${ids.t3}.json`)!.count)).toBeGreaterThanOrEqual(N_T3);
    expect(v.report).toContain('tout l’historique disponible');
  });

  it('L81C-E02 test 2 — volumétrie 2 001 / 10 000 / 50 000 / 500 / 1 000 : complétude, lots, pagination, mémoire bornée', async () => {
    const { withReadSession } = await import('@/services/admin/account-data/session');
    const { planEntityDossier, loadSectionPage } = await import('@/services/admin/account-data/dossier');
    const { writeDossierExport } = await import('@/services/admin/account-data/export');
    const mesures: string[] = [];
    for (const [k, n] of Object.entries(VOL)) {
      const r = await withReadSession(async (s) => {
        const plan = await planEntityDossier(s, A.id, 'asset', ids[k], { only: 'reco-decisions', mode: 'export' });
        const heap0 = process.memoryUsage().heapUsed;
        let peak = heap0;
        let bytes = 0;
        let n2 = 0;
        const t0 = Date.now();
        const m = await writeDossierExport(s, plan, 'json', {
          write: async (c) => {
            bytes += Buffer.byteLength(c);
            n2 += (c.match(/\n {10}\{"id":/g) ?? []).length;
            const h = process.memoryUsage().heapUsed;
            if (h > peak) peak = h;
          },
        }, { sectionId: 'reco-decisions' });
        return { m, bytes, rows: n2, ms: Date.now() - t0, peakMb: (peak - heap0) / 1024 / 1024 };
      });
      expect(r.m.sections[0], k).toMatchObject({ expected: n, exported: n, batches: Math.ceil(n / 500), status: 'COMPLETE' });
      expect(r.rows, k).toBe(n);
      expect(r.m.status).toBe('COMPLETE');
      // Mémoire : bornée à un lot (et non proportionnelle au volume) — 50 000 lignes ≈ plusieurs dizaines de Mo de JSON.
      expect(r.peakMb, `${k} : ${r.peakMb.toFixed(1)} Mo pour ${(r.bytes / 1024 / 1024).toFixed(1)} Mo exportés`).toBeLessThan(96);
      mesures.push(`${k} : ${n} lignes, ${(r.bytes / 1024 / 1024).toFixed(1)} Mo, ${r.m.sections[0].batches} lots, ${r.ms} ms, pic tas +${r.peakMb.toFixed(1)} Mo`);
      // Pagination : dernière page exacte (tailles multiples d'une page comprises).
      const lastOffset = Math.floor((n - 1) / 50) * 50;
      const page = await loadSectionPage(A.id, 'asset', ids[k], 'reco-decisions', { offset: lastOffset, size: 50 });
      expect(page!.window, k).toMatchObject({ total: n, offset: lastOffset });
      expect(page!.table!.rows, k).toHaveLength(n - lastOffset);
    }
    console.log(`[L81C-E02] mesures (heap Node, export JSON en flux) :\n  ${mesures.join('\n  ')}`);
  }, 300_000);

  it('L81C-E03 test 3 — relations : 2 100 équipements, 2 100 documents, 2 050 Opérations retrouvés (périmètre et relations)', async () => {
    await seConnecter('ADMIN');
    const { withReadSession } = await import('@/services/admin/account-data/session');
    const { resolvePerimeter, withDiagnosticPlan } = await import('@/services/admin/diagnostics-export/collect');
    const per = await withReadSession((s) => resolvePerimeter(s.q, { scope: 'asset', id: ids.rel }));
    expect(per.equipmentIds).toHaveLength(2100);
    expect(per.fileIds).toHaveLength(2100);
    expect(per.operationIds).toHaveLength(2050);
    // Plan du diagnostic : un dossier par équipement (2 100), aucun écarté (ancienne borne : 25).
    const plan = await withDiagnosticPlan({ scope: 'asset', id: ids.rel, from: null, to: '2099-12-31', treatments: [], reinforced: false }, { adminUserId: session.userId },
      async (p) => p.entries.map((e) => e.path));
    expect(plan.filter((p) => p.startsWith('metier/equipements/'))).toHaveLength(2100);
    // Relations du tiroir : totaux réels, et export intégral de chaque section de relations.
    const tiroir = await (await entity(A.id, 'asset', ids.rel)).json() as { sections: Section[] };
    expect(sec(tiroir, 'rel-equipements').window).toMatchObject({ total: 2100 });
    // Documents : chaque document peut être relié par plusieurs voies (rattachement, lien) — 2 100 documents distincts.
    const relDocTotal = Number(sec(tiroir, 'rel-documents').window!.total);
    expect(relDocTotal).toBeGreaterThanOrEqual(2100);
    expect(sec(tiroir, 'rel-operations').window).toMatchObject({ total: 2050 });
    for (const [sid, total, distinct] of [['rel-equipements', 2100, 2100], ['rel-documents', relDocTotal, 2100], ['rel-operations', 2050, 2050]] as const) {
      const d = await exportJson(A.id, 'asset', ids.rel, `format=json&section=${sid}`);
      const rel = sec(d, sid).relations!;
      expect(rel, sid).toHaveLength(total);
      expect(new Set(rel.map((r) => `${r.type}-${r.id}`)).size, sid).toBe(distinct);
      expect(new Set(rel.map((r) => `${r.type}-${r.id}-${r.via}-${r.nature}`)).size, `${sid} sans doublon`).toBe(total);
      expect(d.exportStatus).toBe('COMPLETE');
    }
  }, 300_000);

  it('L81C-E04 test 4 — Opérations et TCO : sources, historique, composantes au-delà des anciennes bornes ; 450 lignes TCO toutes tracées', async () => {
    await seConnecter('ADMIN');
    // Écran (OperationDiagnosticsService) : borne d'AFFICHAGE, total réel signalé.
    const tiroir = await (await entity(A.id, 'operation', ids.op)).json() as { sections: Section[]; operationDetail: { sources: unknown[]; history: unknown[]; listTotals: Json; displayLimit: number } };
    expect(tiroir.operationDetail.sources).toHaveLength(200);
    expect(tiroir.operationDetail.listTotals).toMatchObject({ sources: 260, history: 600, components: 450 });
    expect(sec(tiroir, 'sources').window).toMatchObject({ total: 260 });
    // Export intégral : toutes les sources, tous les événements, toutes les composantes.
    const d = await exportJson(A.id, 'operation', ids.op);
    expect(sec(d, 'sources').table!.rows).toHaveLength(260);
    expect(sec(d, 'history').table!.rows).toHaveLength(600);
    expect(sec(d, 'components').table!.rows).toHaveLength(450);
    expect(sec(d, 'rel-operation').relations!.filter((r) => r.type === 'asset')).toHaveLength(1);
    expect(d.exportStatus).toBe('COMPLETE');
    // Diagnostic de l'Opération (tout l'historique) : historique 600 (ancienne borne 500), identité économique 260 sources.
    const zo = await zip(`scope=operation&id=${ids.op}&period=all`);
    expect(JSON.parse(zo.files['logs/historique-operations.json'])).toHaveLength(600);
    expect((JSON.parse(zo.files['tracabilite/identite-economique.json']) as { sources: unknown[] }).sources).toHaveLength(260);
    // TCO du bien : chaque composante est une ligne, chaque ligne est tracée (ancienne borne : 400).
    const z = await zip(`scope=asset&id=${ids.tco}`);
    const traces = JSON.parse(z.files['tracabilite/montants.json']) as Array<{ ligne: Json; chaine: Json[] }>;
    const comps = (await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_financial_components WHERE operation_id = ${ids.op}`).map((c) => `c:${c.id}`);
    const tracees = new Set(traces.map((t) => String(t.ligne.id)));
    expect(comps.filter((c) => !tracees.has(c))).toEqual([]);
    expect(traces.length).toBeGreaterThanOrEqual(450);
    expect(traces.every((t) => t.chaine.length === 7)).toBe(true);
    const tco = JSON.parse(z.files['tracabilite/tco.json']) as Array<{ lignes: number }>;
    expect(traces).toHaveLength(tco[0].lignes);
    const m = JSON.parse(z.files['manifeste.json']) as { files: Array<Json & { path: string }> };
    expect(m.files.find((f) => f.path === 'tracabilite/montants.json')).toMatchObject({ status: 'COMPLETE', count: tco[0].lignes, expected: tco[0].lignes });
  }, 300_000);

  it('L81C-E05 test 5 — JSON / CSV / TXT / ZIP : mêmes lignes, mêmes nombres, manifeste conforme, intégrité', async () => {
    await seConnecter('ADMIN');
    const n = VOL.v2001;
    const expectedIds = (await sql<{ id: number }[]>`SELECT id FROM reconciliation_decisions WHERE asset_id = ${ids.v2001} ORDER BY id`).map((r) => r.id);
    const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
    // JSON
    const j = await exportJson(A.id, 'asset', ids.v2001);
    const jIds = sec(j, 'reco-decisions').table!.rows.map((r) => Number(r.id));
    // CSV long : une ligne par cellule ; colonne « ligne » = identifiant.
    const csvRes = await entity(A.id, 'asset', ids.v2001, 'format=csv');
    const csv = await csvRes.text();
    const cells = (line: string) => { const out: string[] = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ';') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
    const csvRows = csv.split('\r\n').map(cells).filter((c) => c[2] === 'reconciliation_decisions');
    const cIds = [...new Set(csvRows.filter((c) => c[4] === 'id').map((c) => Number(c[3])))];
    expect(csv.trimEnd().split('\r\n').at(-1)).toMatch(/^export;statut;.*;COMPLETE$/);
    // CSV de la section (colonnes de la table)
    const wide = (await (await entity(A.id, 'asset', ids.v2001, 'format=csv&section=reco-decisions')).text()).split('\r\n').filter(Boolean);
    const header = cells(wide[0].replace(/^﻿/, ''));
    const wIds = wide.slice(1).map((l) => Number(cells(l)[header.indexOf('id')]));
    // TXT : lignes « [i] id=… » de la section T3.
    const txt = await (await entity(A.id, 'asset', ids.v2001, 'format=txt')).text();
    const bloc = txt.slice(txt.indexOf('== Décisions de réconciliation T3 du bien'), txt.indexOf('\n== ', txt.indexOf('== Décisions de réconciliation T3 du bien') + 5));
    const tIds = [...bloc.matchAll(/^ {2}\[\d+\] id=(\d+) ;/gm)].map((x) => Number(x[1]));
    expect(txt.trimEnd().split('\n').at(-1)).toMatch(/^Statut de l’export : COMPLETE/);
    // ZIP du diagnostic
    const z = await zip(`scope=asset&id=${ids.v2001}`);
    const zIds = sec(JSON.parse(z.files[`metier/bien-${ids.v2001}.json`]) as { sections: Section[] }, 'reco-decisions').table!.rows.map((r) => Number(r.id));
    for (const [fmt, got] of [['json', jIds], ['csv', cIds], ['csv-section', wIds], ['txt', tIds], ['zip', zIds]] as const) {
      expect(got, fmt).toHaveLength(n);
      expect(sorted(got), fmt).toEqual(expectedIds);
    }
    // Valeurs identiques entre JSON et ZIP (même masquage de base, mêmes lignes).
    expect(sec(JSON.parse(z.files[`metier/bien-${ids.v2001}.json`]) as { sections: Section[] }, 'reco-decisions').table!.rows[0]).toEqual(sec(j, 'reco-decisions').table!.rows[0]);
    // Manifeste : chaque fichier avec statut, attendu / exporté, SHA-256 vérifiable.
    const m = JSON.parse(z.files['manifeste.json']) as { status: string; files: Array<{ path: string; sha256?: string; bytes?: number; status?: string; count?: number; expected?: number | null }> };
    expect(m.status).toBe('COMPLETE');
    for (const f of m.files) {
      if (f.path === 'manifeste.json') continue;
      expect(z.files[f.path], f.path).toBeDefined();
      expect(createHash('sha256').update(z.files[f.path]).digest('hex'), f.path).toBe(f.sha256);
      expect(Buffer.byteLength(z.files[f.path]), f.path).toBe(f.bytes);
      expect(f.status, f.path).toBe('COMPLETE');
      if (f.expected !== undefined && f.expected !== null && f.path.endsWith('.json') && !f.path.startsWith('metier/')) expect(f.count, f.path).toBe(f.expected);
    }
    expect(Object.keys(z.files).sort()).toEqual([...m.files.map((f) => f.path)].sort());
    // Manifeste de l'export JSON : sections, totaux cohérents.
    expect(j.export).toMatchObject({ status: 'COMPLETE', totals: { exported: (j.export.totals as Json).expected } });
  }, 300_000);

  it('L81C-E06 test 6 — interruption, délai SQL, échec d’archive, reprise, écritures concurrentes, client parti : jamais COMPLETE si des données manquent', async () => {
    const admin = await seConnecter('ADMIN');
    const { withReadSession } = await import('@/services/admin/account-data/session');
    const { planEntityDossier } = await import('@/services/admin/account-data/dossier');
    const { exportToString } = await import('@/services/admin/account-data/export');
    const sessionMod = await import('@/services/admin/account-data/session');
    const t3sql = /FROM reconciliation_decisions WHERE account_id/;

    // 1. Interruption pendant l'extraction (curseur coupé après 2 lots).
    const coupe = await withReadSession(async (s) => {
      const plan = await planEntityDossier(s, A.id, 'asset', ids.v10000, { mode: 'export' });
      return exportToString(s, plan, 'json');
    }, { cursor: (c) => (text, params, batch) => (t3sql.test(text) ? (async function* () { let k = 0; for await (const lot of c(text, params, batch)) { if (k++ === 2) throw Object.assign(new Error('connexion interrompue (simulée)'), { code: '08006' }); yield lot; } })() : c(text, params, batch)) });
    const cj = JSON.parse(coupe.text) as { sections: Section[]; exportStatus: string; export: Json };
    expect(sec(cj, 'reco-decisions').extraction).toMatchObject({ expected: 10_000, exported: 1000, status: 'PARTIAL', error: expect.stringContaining('08006') });
    expect(cj.exportStatus).toBe('PARTIAL');
    expect(sec(cj, 'reco-runs').extraction).toMatchObject({ status: 'COMPLETE' });         // sections indépendantes lues
    expect(coupe.text).toMatch(/"exportStatus": "PARTIAL"\n}\n$/);

    // 2. Dépassement de délai SQL (57014) : section FAILED, autres sections lues.
    const delai = await withReadSession(async (s) => {
      const plan = await planEntityDossier(s, A.id, 'asset', ids.v1000, { mode: 'export' });
      return exportToString(s, plan, 'txt');
    }, { q: (q) => async (text, params) => {
      if (/count\(\*\)::bigint AS n FROM \(SELECT \* FROM reconciliation_decisions/.test(text)) { await q('SET LOCAL statement_timeout = 50'); return q('SELECT pg_sleep(2)'); }
      return q(text, params);
    } });
    expect(delai.manifest.sections.find((x) => x.id === 'reco-decisions')).toMatchObject({ status: 'FAILED', error: expect.stringContaining('57014') });
    expect(delai.manifest.status).toBe('PARTIAL');
    expect(delai.manifest.sections.find((x) => x.id === 'reco-runs')).toMatchObject({ status: 'COMPLETE', exported: 1 });
    expect(delai.text.trimEnd().split('\n').at(-1)).toMatch(/^Statut de l’export : PARTIAL/);

    // 3. Échec de génération d'archive (erreur fatale pendant la production) : flux interrompu, génération FAILED, journal FAILURE.
    const real = sessionMod.openReadSession;
    const spy = vi.spyOn(sessionMod, 'openReadSession').mockImplementation((w) => real({ ...w, cursor: (c) => (text, params, batch) => {
      if (/FROM ai_operation/.test(text)) throw Object.assign(new Error('écriture refusée (simulée)'), { code: '25006' });
      return c(text, params, batch);
    } }));
    const res = await diag(`scope=asset&id=${ids.v2001}&format=zip`);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer().then((b) => JSZip.loadAsync(Buffer.from(b)))).rejects.toBeTruthy();
    spy.mockRestore();
    const echec = await sql<{ status: string; error: string; mode: string }[]>`SELECT status, error, mode FROM admin_export_generations WHERE admin_user_id = ${admin.id} AND kind = 'TECH_DIAGNOSTIC' ORDER BY started_at DESC LIMIT 1`;
    expect(echec[0]).toMatchObject({ status: 'FAILED', mode: 'zip' });
    expect(echec[0].error).toContain('25006');
    expect((await sql`SELECT result, details FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type = 'TECH_DIAGNOSTIC_EXPORT' ORDER BY id DESC LIMIT 1`)[0]).toMatchObject({ result: 'FAILURE' });

    // 4. Reprise après interruption : nouvelle génération complète, aucune ligne dupliquée.
    const z = await zip(`scope=asset&id=${ids.v2001}`);
    const rows = sec(JSON.parse(z.files[`metier/bien-${ids.v2001}.json`]) as { sections: Section[] }, 'reco-decisions').table!.rows.map((r) => Number(r.id));
    expect(rows).toHaveLength(VOL.v2001);
    expect(new Set(rows).size).toBe(VOL.v2001);
    expect((JSON.parse(z.files['manifeste.json']) as Json).status).toBe('COMPLETE');

    // 5. Écritures concurrentes pendant l'export : instantané — ni doublon, ni omission, ni ligne apparue / disparue.
    const avantIds = (await sql<{ id: number }[]>`SELECT id FROM reconciliation_decisions WHERE asset_id = ${ids.v10000} ORDER BY id`).map((r) => r.id);
    let ecrit = false;
    let supprimees: Json[] = [];
    const conc = await withReadSession(async (s) => {
      const plan = await planEntityDossier(s, A.id, 'asset', ids.v10000, { only: 'reco-decisions', mode: 'export' });
      return exportToString(s, plan, 'json', { sectionId: 'reco-decisions' });
    }, { cursor: (c) => (text, params, batch) => (t3sql.test(text) ? (async function* () {
      for await (const lot of c(text, params, batch)) {
        yield lot;
        if (!ecrit) {
          ecrit = true;
          const [run] = await sql<{ run_id: number }[]>`SELECT run_id FROM reconciliation_decisions WHERE asset_id = ${ids.v10000} LIMIT 1`;
          await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence)
                    SELECT ${run.run_id}, ${A.id}, ${ids.v10000}, 'concurrent', 'keep', 'C' || g, 'certain' FROM generate_series(1, 100) g`;
          supprimees = await sql`DELETE FROM reconciliation_decisions WHERE id IN (SELECT id FROM reconciliation_decisions WHERE asset_id = ${ids.v10000} ORDER BY id LIMIT 10) RETURNING *`;
        }
      }
    })() : c(text, params, batch)) });
    expect(ecrit).toBe(true);
    const cr = sec(JSON.parse(conc.text) as { sections: Section[] }, 'reco-decisions').table!.rows.map((r) => Number(r.id));
    expect(conc.manifest.status).toBe('COMPLETE');
    expect(cr).toHaveLength(10_000);
    expect([...cr].sort((a, b) => a - b)).toEqual(avantIds);
    expect(Date.parse(conc.manifest.snapshot.at)).toBeLessThan(Date.now());
    expect(supprimees).toHaveLength(10);
    // Remise en état du jeu (lignes concurrentes, lignes supprimées) pour les empreintes.
    await sql`DELETE FROM reconciliation_decisions WHERE asset_id = ${ids.v10000} AND field_key = 'concurrent'`;
    await sql`INSERT INTO reconciliation_decisions ${sql(supprimees.map((r) => ({ ...r, evidence_ids: JSON.stringify(r.evidence_ids) })) as never)}`;

    // 6. Client parti en cours de téléchargement : génération FAILED (jamais COMPLETE), connexion rendue.
    const exp = await entity(A.id, 'asset', ids.v50000, 'format=json');
    const reader = exp.body!.getReader();
    await reader.read();
    await reader.cancel();
    const genId = exp.headers.get('X-Verebona-Export-Id')!;
    let st: { status: string; error: string | null } | undefined;
    for (let i = 0; i < 100 && (!st || st.status === 'RUNNING'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      [st] = await sql<{ status: string; error: string | null }[]>`SELECT status, error FROM admin_export_generations WHERE id = ${genId}`;
    }
    expect(st).toMatchObject({ status: 'FAILED' });
    expect(st!.error).toMatch(/flux fermé|client/);
    // Statut lu en fin de fichier : un fichier interrompu n'a pas de marque (jamais présenté comme complet).
    const { exportStatusFromTail } = await import('@/services/admin/account-data/model');
    expect(exportStatusFromTail('json', coupe.text.slice(0, coupe.text.length - 200))).toBeNull();
  }, 300_000);

  it('L81C-E07 test 7 — sécurité : droits, intercomptes, masquage, lecture seule, suivi réservé', async () => {
    await seConnecter('USER');
    expect((await entity(A.id, 'asset', ids.t3, 'section=reco-decisions&offset=50')).status).toBe(403);
    expect((await entity(A.id, 'asset', ids.t3, 'format=json')).status).toBe(403);
    expect((await gensGET(new NextRequest('http://app.test/api/admin/diagnostics/generations'))).status).toBe(403);
    expect((await diag(`scope=asset&id=${ids.t3}&period=all&format=zip`)).status).toBe(403);
    const admin = await seConnecter('ADMIN');
    // Intercomptes : bien de B demandé par A → 404 (page de section et export), journalisé DENIED.
    expect((await entity(A.id, 'asset', ids.assetB, 'section=reco-decisions')).status).toBe(404);
    expect((await entity(A.id, 'asset', ids.assetB, 'format=csv&section=reco-decisions')).status).toBe(404);
    expect((await sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND result = 'DENIED'`)[0].n).toBe(2);
    // Section inconnue / identifiant de section non conforme : 400, jamais de SQL libre.
    expect((await entity(A.id, 'asset', ids.t3, 'section=inconnue&format=json')).status).toBe(400);
    expect((await entity(A.id, 'asset', ids.t3, "section=x';drop")).status).toBe(400);
    // Masquage : donnée sensible du registre absente de la page, de la recherche et des exports.
    const page = await (await entity(A.id, 'asset', ids.t3, 'section=bdd-kc')).json();
    expect(JSON.stringify(page)).not.toContain('9 impasse Secrète L81C');
    const recherche = await (await entity(A.id, 'asset', ids.t3, 'section=field-evidence&q=impasse')).json();
    expect(JSON.stringify(recherche)).not.toContain('Secrète');
    for (const f of ['json', 'csv', 'txt']) expect(await (await entity(A.id, 'asset', ids.t3, `format=${f}`)).text(), f).not.toContain('9 impasse Secrète L81C');
    // Lecture seule : la session d'export refuse toute écriture (25006).
    const { withReadSession } = await import('@/services/admin/account-data/session');
    await expect(withReadSession((s) => s.q(`UPDATE assets SET name = 'x' WHERE id = $1`, [ids.t3]))).rejects.toMatchObject({ code: '25006' });
    // Suivi des générations : réservé, paginé, statuts et erreurs exploitables.
    const g = await (await gensGET(new NextRequest('http://app.test/api/admin/diagnostics/generations?pageSize=100'))).json() as { items: Array<{ status: string; kind: string }>; total: number };
    expect(g.total).toBeGreaterThan(0);
    expect(g.items.some((x) => x.kind === 'ACCOUNT_DATA' && x.status === 'COMPLETE')).toBe(true);
    expect(g.items.some((x) => x.status === 'FAILED')).toBe(true);
    expect((await gensGET(new NextRequest('http://app.test/api/admin/diagnostics/generations?kind=X'))).status).toBe(400);
  }, 300_000);

  it('L81C-E09 complément 81A — inconsistency_registry et t3_information_checks : sections exhaustives du dossier du bien (tiroir, export, ZIP), masquage', async () => {
    await seConnecter('ADMIN');
    const bien = await make.asset(A, { category: 'IMMOBILIER', name: 'Bien incohérences L81C' });
    await sql`INSERT INTO inconsistency_registry (account_id, asset_id, field_key, current_value, proposed_value, source_type, status)
              SELECT ${A.id}, ${bien.id}, 'champ_' || g, 'v' || g, 'p' || g, 'document', CASE WHEN g % 2 = 0 THEN 'resolved' ELSE 'open' END FROM generate_series(1, 2100) g`;
    await sql`INSERT INTO inconsistency_registry (account_id, asset_id, field_key, current_value, proposed_value, source_type)
              VALUES (${A.id}, ${bien.id}, 'address1', '5 rue Cachée L81C', '7 rue Cachée L81C', 'document')`;
    await sql`INSERT INTO t3_information_checks (asset_id, account_id, check_version, summary) VALUES (${bien.id}, ${A.id}, 'v76j-1', '{"verifies": 12}'::jsonb)`;
    const tiroir = await (await entity(A.id, 'asset', bien.id)).json() as { sections: Section[] };
    expect(sec(tiroir, 'inconsistencies').window).toMatchObject({ total: 2101 });
    expect(sec(tiroir, 't3-information-checks').table!.rows[0]).toMatchObject({ check_version: 'v76j-1', summary: { verifies: 12 } });
    const d = await exportJson(A.id, 'asset', bien.id);
    expect(sec(d, 'inconsistencies').table!.rows).toHaveLength(2101);
    expect(sec(d, 'inconsistencies').extraction).toMatchObject({ status: 'COMPLETE', expected: 2101, exported: 2101 });
    expect(sec(d, 't3-information-checks').table!.rows).toHaveLength(1);
    const z = await zip(`scope=asset&id=${bien.id}`);
    const zd = JSON.parse(z.files[`metier/bien-${bien.id}.json`]) as { sections: Section[] };
    expect(sec(zd, 'inconsistencies').table!.rows).toHaveLength(2101);
    expect(sec(zd, 't3-information-checks').table!.rows).toHaveLength(1);
    // Masquage : valeurs d'une clé sensible du registre (adresse) jamais rendues.
    for (const out of [JSON.stringify(tiroir), JSON.stringify(d), z.files[`metier/bien-${bien.id}.json`]]) expect(out).not.toContain('rue Cachée L81C');
    await sql`DELETE FROM inconsistency_registry WHERE asset_id = ${bien.id}`;
    await sql`DELETE FROM t3_information_checks WHERE asset_id = ${bien.id}`;
    await sql`DELETE FROM assets WHERE id = ${bien.id}`;
  }, 300_000);

  it('L81C-E08 aucune écriture métier : empreintes identiques après toutes les consultations et générations', async () => {
    expect(await empreinte()).toBe(avant);
  });
});
