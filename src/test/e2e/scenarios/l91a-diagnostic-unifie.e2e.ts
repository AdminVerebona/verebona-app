/**
 * Lot 91A — diagnostic UNIFIÉ (correction du P1 « Rendre le diagnostic global
 * exhaustif et auto-suffisant »), sur PostgreSQL 16 réel, BASE DÉDIÉE (le
 * périmètre « Ensemble de l'application » exporte toute la base : il doit
 * être évalué sur une base dont on connaît chaque ligne), PAR LA VRAIE ROUTE
 * (`GET /api/admin/diagnostics`, garde `requireAdmin` réelle : seule la
 * lecture du cookie de session est simulée).
 *
 * Cas de référence « Maison » (valeurs neutres de jeu de test ; aucune
 * constante métier dans la logique du diagnostic) : un bien immobilier dont
 * le prix d'achat est VIDE alors que l'acte en porte le montant (490 000 €) ;
 * documents, extraction, faits, unités sources, preuve, décision T3,
 * reprise de propriété manquante (abstention), contrôle de cohérence et
 * autoréparation, écriture canonique, Opération et composante financière
 * (TCO), traitement T1, appel IA et capture. Un second compte a ses propres
 * données.
 *
 *   · L91A-E01 « Ensemble de l'application » : COMPLETE, aucune section
 *     NOT_APPLICABLE, tous les comptes couverts, aucune table hors filtre,
 *     tables transversales exportées, attendu = exporté et SHA-256 pour
 *     chaque fichier, manifeste par section et par fichier ;
 *   · L91A-E02 le cas « Maison » est ENTIÈREMENT diagnosticable depuis le
 *     SEUL ZIP global (aucun second export) : bien et état canonique,
 *     acquisitionPrice vide, documents, montant 490 000 €, faits, extractions,
 *     preuves, Opération, décision T3, contrôles de cohérence et
 *     property_recovery_*, écritures, API / affichage, jobs et appels IA ;
 *   · L91A-E03 RÈGLE AUTOMATIQUE : chaque diagnostic filtré (compte,
 *     utilisateur, bien, document, Opération) est inclus dans le global
 *     (`filteredIncludedInGlobal` : aucune violation) ; isolation des filtres ;
 *   · L91A-E04 volume : fichiers `part-NNNN` (attendu = exporté par partie,
 *     total identique au fichier unique), jamais « sur ? » ;
 *   · L91A-E05 sécurité : secrets, jetons, prompts, e-mails absents même au
 *     global ; exclusions limitées à la sécurité et au contenu personnel ;
 *   · L91A-E06 auto-contrôle : référence pendante et compteur annoncé non
 *     détaillé → global PARTIAL, déclarés (jamais COMPLETE) ;
 *   · L91A-E07 raccourci « Données du compte » : filtre compte prérempli ;
 *     ancien paramètre de période ignoré ; périmètre inconnu 400.
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminUrlFromEnv, bootstrapE2eDatabase, dropE2eDatabase } from '../db-bootstrap';
import { factories, type AccountRow, type Factories } from '../factories';

type Json = Record<string, any>;

const ADMIN = adminUrlFromEnv();
const BASE = `verebona_e2e_l91a_${Date.now()}_${process.pid}`;
const PROMPT_SECRET = 'Analyse cet acte — clé sk-l91aFAKEFAKEFAKEFAKEFAKE1234';

describe('L91A — Diagnostic unifié : « Ensemble de l’application » exhaustif, filtres inclus dans le global', () => {
  let sql: postgres.Sql;
  let make: Factories;
  const session = { userId: 0, role: 'USER', email: '' };
  let GET: (r: import('next/server').NextRequest) => Promise<Response>;
  let NextRequest: typeof import('next/server').NextRequest;
  const ids: Record<string, number> = {};
  let A: AccountRow & { owner: { id: number; email: string } };
  let B: AccountRow & { owner: { id: number; email: string } };

  const appel = (qs: string) => GET(new NextRequest(`http://app.test/api/admin/diagnostics?${qs}`));
  async function seConnecter(role: 'ADMIN' | 'USER') {
    const u = await make.user({ role });
    session.userId = u.id; session.role = role; session.email = u.email;
    return u;
  }
  async function zip(qs: string): Promise<{ files: Record<string, string>; raw: string }> {
    const res = await appel(`${qs}&format=zip`);
    expect(res.status, await res.clone().text().catch(() => '')).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const files: Record<string, string> = {};
    for (const [name, f] of Object.entries(z.files)) if (!f.dir) files[name] = await f.async('string');
    for (const [name, c] of Object.entries(files)) if (name.endsWith('.json')) expect(() => JSON.parse(c), name).not.toThrow();
    return { files, raw: Object.values(files).join('\n') };
  }
  const parse = <T = Json>(files: Record<string, string>, p: string): T => {
    expect(files[p], `fichier ${p} absent du ZIP`).toBeDefined();
    return JSON.parse(files[p]) as T;
  };
  /** Lignes d'une table (toutes parties, fermeture comprise). */
  const rows = (files: Record<string, string>, table: string): Json[] => Object.keys(files)
    .filter((p) => new RegExp(`^donnees/[a-z-]+/${table}(\\.part-\\d{4})?\\.json$`).test(p)).sort().flatMap((p) => JSON.parse(files[p]) as Json[]);

  beforeAll(async () => {
    const boot = await bootstrapE2eDatabase({ adminUrl: ADMIN!, database: BASE });
    // `@/db` lit DATABASE_URL à son premier import : il vise désormais la base de CE scénario.
    process.env.DATABASE_URL = boot.url;
    vi.resetModules();
    const { pgClient } = await import('@/db');
    sql = pgClient;
    make = factories(pgClient);
    const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    if (db !== BASE) throw new Error(`[l91a] base inattendue : ${db} (attendue ${BASE}) — @/db importé avant le changement de DATABASE_URL`);
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    GET = (await import('@/app/api/admin/diagnostics/route')).GET as never;

    // ── Compte A : cas « Maison » ────────────────────────────────────────
    A = await make.account({ plan: 'premium', name: 'Compte Maison L91A' });
    B = await make.account({ plan: 'premium', name: 'Compte Second L91A' });
    await sql`UPDATE users SET password_hash = 'HASH-SECRET-L91A-$2b$10$abcdefghijklmnop' WHERE id = ${A.owner.id}`;
    await sql`UPDATE accounts SET calendar_share_token = 'JETON-PARTAGE-L91A-123456' WHERE id = ${A.id}`;
    const maison = await make.asset(A, {
      category: 'IMMOBILIER', name: 'Maison L91A',
      keyCharacteristics: { acquisitionDate: '2021-09-14', acquisitionDate__origin: 'DOCUMENT_EXTRACTION' },
    });
    ids.asset = maison.id;
    const doc = async (title: string, date: string, amountCents: number | null) => {
      const f = await make.assetFile(A, { assetId: maison.id });
      await sql`UPDATE asset_files SET retained_title = ${title}, document_date = ${date}, amount_cents = ${amountCents}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
      const ex = Number((await sql<{ id: number }[]>`
        INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, operation_trace_id, fact_count, document_date, amount_cents, currency)
        VALUES (${A.id}, ${f.id}, 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v7', ${`tr-l91a-${f.id}`}, 1, ${date}, ${amountCents}, 'EUR') RETURNING id`)[0].id);
      return { file: f.id, extraction: ex };
    };
    const acte = await doc('Acte de vente', '2021-09-14', 49_000_000);
    const pret = await doc('Offre de prêt', '2021-07-01', null);
    Object.assign(ids, { acte: acte.file, pret: pret.file, exActe: acte.extraction, exPret: pret.extraction });
    ids.factPrix = Number((await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, raw_value, confidence, excerpt, location, status, provider, model, prompt_version, source_unit_ids)
      VALUES (${A.id}, ${acte.file}, ${acte.extraction}, 'acquisitionPrice', 'acquisitionPrice', 'Prix', 490000, 'EUR', '490 000,00 €', 'certain', 'Prix : 490 000,00 €', '{"page": 2}'::jsonb, 'active',
              'gemini', 'gemini-2.5-pro', 't1_analyze_document@v7', ${['p2-u1']}) RETURNING id`)[0].id);
    ids.factPret = Number((await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, confidence, excerpt, location, status, source_unit_ids)
      VALUES (${A.id}, ${pret.file}, ${pret.extraction}, 'loanAmount', 'loanAmount', 'Montant', 300000, 'EUR', 'certain', 'Montant : 300 000 €', '{"page": 1}'::jsonb, 'active', ${['p1-u1']}) RETURNING id`)[0].id);
    for (const [d, unit, page, text] of [[acte, 'p2-u1', 2, 'Prix : 490 000,00 €'], [pret, 'p1-u1', 1, 'Montant : 300 000 €']] as const) {
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, content_text, coverage_status)
                VALUES (${A.id}, ${d.file}, ${d.extraction}, ${unit}, 'TEXT_BLOCK', ${page}, 1, ${text}, 'COVERED')`;
    }
    ids.evPrix = Number((await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, normalized_value, source_type, source_id, source_location, evidence_excerpt,
                                  confidence, authority_score, status, lifecycle_status, fingerprint, provider, model, prompt_version, target_type, target_entity_id)
      VALUES (${A.id}, ${maison.id}, 'acquisitionPrice', 'acquisitionPrice', '490000'::jsonb, '490000', 'document', ${acte.file}, '{"page": 2}'::jsonb, 'Prix : 490 000,00 €',
              'certain', 80, 'active', 'ACTIVE', ${`l91a-${acte.file}-prix`}, 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v7', 'ASSET', ${maison.id}) RETURNING id`)[0].id);

    // T3 : passage, décision sur le prix (revue), écriture de la date.
    const run = (await sql<{ id: number; trace: string }[]>`
      INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, shadow, trace_id, status, decisions_count, applied_count, conflict_count)
      VALUES (${A.id}, ${maison.id}, 'document_analyzed', false, gen_random_uuid(), 'completed', 1, 0, 0) RETURNING id, trace_id::text AS trace`)[0];
    ids.run = Number(run.id);
    ids.decPrix = Number((await sql<{ id: number }[]>`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
      VALUES (${ids.run}, ${A.id}, ${maison.id}, 'acquisitionPrice', 'request_ai_review', 'AMBIGUOUS_SOURCE', 'probable', true, ${JSON.stringify([ids.evPrix])}::jsonb) RETURNING id`)[0].id);
    ids.ecriture = Number((await sql<{ id: number }[]>`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, trace_id, outcome, dry_run)
      VALUES (${A.id}, ${maison.id}, 'acquisitionDate', 'null'::jsonb, '"2021-09-14"'::jsonb, 'RECONCILIATION', 'document', ${String(acte.file)}, ${run.trace}, 'written', false) RETURNING id`)[0].id);

    // Reprise de propriété manquante (lot 88B) : abstention motivée, preuve citée.
    ids.recRun = Number((await sql<{ id: number }[]>`INSERT INTO property_recovery_runs (account_id, asset_id, object_type, object_id, context_fp, contract_version, batch_fp, properties, status, trigger_code)
      VALUES (${A.id}, ${maison.id}, 'ASSET', ${maison.id}, 'ctx-l91a', 'v1', 'batch-l91a', ${['acquisitionPrice']}, 'ANSWERED', 'COH-MISSING-PROPERTIES') RETURNING id`)[0].id);
    ids.recDecision = Number((await sql<{ id: number }[]>`INSERT INTO property_recovery_decisions (run_id, account_id, asset_id, object_type, object_id, field_key, question_fp, context_fp, decision, cause, proposed_value, evidence_ids, write_outcome)
      VALUES (${ids.recRun}, ${A.id}, ${maison.id}, 'ASSET', ${maison.id}, 'acquisitionPrice', 'q-l91a', 'ctx-l91a', 'ABSTAINED', 'AMBIGUOUS_SOURCES', '490000'::jsonb, ${[ids.evPrix]}, 'NOT_WRITTEN') RETURNING id`)[0].id);

    // Contrôle de cohérence : campagne, preuve de contrôle, autoréparation.
    ids.campaign = Number((await sql<{ id: number }[]>`INSERT INTO coherence_campaigns (kind, mode, trigger_code, registry_version, status, scope_account_ids)
      VALUES ('DAILY', 'CORRECTIVE', 'scheduled', 'r-l91a', 'COMPLETE', ${[A.id, B.id]}) RETURNING id`)[0].id);
    await sql`INSERT INTO coherence_object_proofs (account_id, check_id, object_id, object_type, rules_version, registry_version, last_campaign_id, last_result)
              VALUES (${A.id}, 'COH-MISSING-PROPERTIES', ${maison.id}, 'asset', 1, 'r-l91a', ${ids.campaign}, 'FINDING')`;
    ids.repair = Number((await sql<{ id: number }[]>`INSERT INTO coherence_repairs (campaign_id, account_id, check_id, check_version, object_type, object_id, trigger_code, anomaly, service, outcome)
      VALUES (${ids.campaign}, ${A.id}, 'COH-MISSING-PROPERTIES', 1, 'asset', ${maison.id}, 'scheduled', 'propriété vide : acquisitionPrice', 'property-recovery', 'INEFFECTIVE') RETURNING id`)[0].id);

    // Opération d'acquisition : composante 490 000 € (TCO), source documentaire = l'acte.
    ids.op = Number((await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date)
      VALUES (${A.id}, 'ACQUISITION', 'REALIZED', 'Acquisition Maison L91A', 'Notaire', '2021-09-14') RETURNING id`)[0].id);
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${A.id}, ${ids.op}, ${maison.id}, 'PRIMARY', 'STRUCTURED')`;
    ids.source = Number((await sql<{ id: number }[]>`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority, source_role)
      VALUES (${A.id}, ${ids.op}, 'DOCUMENT', ${String(acte.file)}, 'DOCUMENT', 'SALE_DOCUMENT') RETURNING id`)[0].id);
    ids.component = Number((await sql<{ id: number }[]>`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, target_asset_id, label)
      VALUES (${A.id}, ${ids.op}, 'REALIZED_COST', 49000000, 'EUR', ${maison.id}, 'Prix d’acquisition') RETURNING id`)[0].id);
    await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, evidence_role, is_primary) VALUES (${ids.component}, ${ids.source}, 'SUPPORTS', true)`;

    // Traitements : job T1, appel IA (capture avec prompt), rapport T1 détaillé.
    ids.job = Number((await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, trigger_code, attempts, last_error, finished_at)
      VALUES ('T1', ${A.id}, 'asset_file', ${String(acte.file)}, ${`l91a-t1-${acte.file}`}, 'DONE', 'source_uploaded', 2, 'tentative 1 : délai dépassé', now()) RETURNING id`)[0].id);
    ids.usage = Number((await sql<{ id: number }[]>`INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, status, input_tokens, output_tokens, metadata, job_id, operation_code, environment, master_prompt_code, master_prompt_version)
      VALUES (${A.id}, ${acte.file}, 'extraction', 'gemini', 'gemini-2.5-pro', 'success', 1500, 400, ${JSON.stringify({ traceId: `tr-l91a-${acte.file}` })}::jsonb, ${ids.job}, 't1_analyze_document', 'test', 'T1_MASTER', '7')
      RETURNING id`)[0].id);
    await sql`INSERT INTO ai_call_captures (trace_id, usage_event_id, call_index, call_kind, origin, account_id, operation_code, model, capture_status, prompt_status, response_status, prompt_text, prompt_chars, response_raw, response_chars)
              VALUES (${`tr-l91a-${acte.file}`}, ${ids.usage}, 0, 'PRIMARY', 'T1', ${A.id}, 't1_analyze_document', 'gemini-2.5-pro', 'CAPTURED', 'CAPTURED', 'CAPTURED', ${PROMPT_SECRET}, ${PROMPT_SECRET.length}, '{"acquisitionPrice": 490000}', 28)`;
    ids.report = Number((await sql<{ id: number }[]>`INSERT INTO ai_execution_reports (account_id, treatment, scope, job_id, trace_ids, file_id, asset_id, extraction_id, status, entry_count, counters)
      VALUES (${A.id}, 'T1', 'DOCUMENT', ${ids.job}, ${[`tr-l91a-${acte.file}`]}, ${acte.file}, ${maison.id}, ${acte.extraction}, 'SUCCESS', 1, ${JSON.stringify({ factsPersisted: 1 })}::jsonb) RETURNING id`)[0].id);
    await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, table_name, record_id, field_key, value, write_result)
              VALUES (${ids.report}, 1, ${A.id}, 'FACT', 'document_facts', ${String(ids.factPrix)}, 'acquisitionPrice', '490000'::jsonb, 'WRITTEN')`;
    await sql`INSERT INTO admin_anomalies (domain, fingerprint, title, account_id) VALUES ('ai', ${`l91a-${A.id}`}, 'T1 : relance (E2E L91A)', ${A.id})`;
    // Journal d'administration (table transversale) : e-mail d'administrateur à pseudonymiser.
    await sql`INSERT INTO admin_audit_log (admin_user_id, admin_email, action_type, target_type, target_id, details, result)
              VALUES (${A.owner.id}, 'admin.l91a@example.fr', 'L91A_TEST', 'ACCOUNT', ${A.id}, '{"note":"contact admin.l91a@example.fr"}', 'SUCCESS')`;

    // ── Compte B : ses propres données (le global couvre tous les comptes) ─
    const autre = await make.asset(B, { category: 'VEHICULE', name: 'Voiture Seconde L91A', keyCharacteristics: { acquisitionPrice: 12345 } });
    ids.assetB = autre.id;
    ids.fileB = (await make.assetFile(B, { assetId: autre.id })).id;
    for (const k of Object.keys(ids)) ids[k] = Number(ids[k]);
  }, 600_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    const { pgClient } = await import('@/db');
    await pgClient.end({ timeout: 5 }).catch(() => undefined);
    await dropE2eDatabase(ADMIN!, BASE, { force: true }).catch(() => undefined);
  });

  let G: { files: Record<string, string>; raw: string };

  it('L91A-E01 « Ensemble de l’application » : COMPLETE, aucune section non applicable, tous les comptes, tables transversales', async () => {
    await seConnecter('ADMIN');
    G = await zip('scope=global');
    const m = parse(G.files, 'manifeste.json');
    expect(m.schema).toBe('verebona.bo.diagnostic/2');
    expect(m.request).toMatchObject({ scope: 'global', id: null, scopeLabel: 'Ensemble de l’application' });
    expect(m.target).toMatchObject({ allAccounts: true });
    expect(m.status, JSON.stringify((m.sections as Json[]).filter((x) => x.status !== 'COMPLETE').map((x) => [x.code, x.status, x.motif, x.errors]), null, 1)).toBe('COMPLETE');
    // Aucune section NOT_APPLICABLE au global (toute donnée de Verebona y est applicable).
    for (const s of m.sections as Json[]) {
      expect(s.status, `${s.code} : ${s.motif}`).toBe('COMPLETE');
      expect(s.files.length, s.code).toBeGreaterThan(0);
    }
    // Couverture : toutes les tables, tous les comptes, aucune table hors filtre ; exclusions = sécurité / contenu personnel seulement.
    expect(m.couverture.horsFiltre).toEqual([]);
    expect(m.couverture.nonClassees).toEqual([]);
    const nComptes = Number((await sql`SELECT count(*)::int AS n FROM accounts`)[0].n);
    expect(m.couverture.comptes).toMatchObject({ attendus: nComptes, couverts: nComptes });
    expect(m.autoControle.comptes).toMatchObject({ attendus: nComptes, couverts: nComptes, erreurs: 0 });
    expect(new Set((m.exclusionsVolontaires.tables as Json[]).map((t) => t.categorie))).toEqual(new Set(['SECURITE', 'CONTENU_PERSONNEL']));
    const tables = (await sql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((r) => r.t);
    expect(m.couverture.exportees + m.couverture.exclues).toBe(tables.length);
    expect(rows(G.files, 'accounts').map((a) => a.id)).toEqual(expect.arrayContaining([A.id, B.id]));
    expect(parse<Json>(G.files, 'controle/comptes.json').comptes.map((c: Json) => c.compte)).toEqual(expect.arrayContaining([A.id, B.id]));
    // Tables transversales (journaux multi-comptes, configuration, catalogue) : exportées au global.
    for (const p of ['donnees/historique/admin_audit_log.json', 'donnees/referentiels/ai_model_catalog.json', 'donnees/referentiels/plan_limits.json', 'donnees/technique/email_logs.json']) expect(G.files[p], p).toBeDefined();
    // Manifeste par fichier : section, attendu = exporté (jamais « sur ? »), statut, SHA-256 vérifiable.
    for (const f of m.files as Json[]) {
      expect(f.section, f.path).toBeTruthy();
      if (f.path === 'manifeste.json') continue;
      expect(G.files[f.path], f.path).toBeDefined();
      expect(f.status, f.path).toBe('COMPLETE');
      expect(createHash('sha256').update(G.files[f.path]).digest('hex'), f.path).toBe(f.sha256);
      if (f.expected !== null && f.expected !== undefined) expect(f.count, f.path).toBe(f.expected);
      else if (f.count !== undefined) expect.fail(`${f.path} : exporté sans attendu`);
    }
    expect(Object.keys(G.files).sort()).toEqual((m.files as Json[]).map((f) => f.path).sort());
    expect(G.files['rapport.txt']).not.toMatch(/sur \?|\/ \? attendu/);
    expect(G.files['LISEZMOI-ANALYSE.md']).toMatch(/niveau maximal/);
  }, 300_000);

  it('L91A-E02 cas « Maison » : entièrement diagnosticable depuis le SEUL ZIP global', () => {
    const F = G.files;
    // Bien et état canonique ; propriété vide.
    expect(rows(F, 'assets').find((a) => a.id === ids.asset)).toMatchObject({ account_id: A.id, category: 'IMMOBILIER', name: 'Maison L91A' });
    const props = parse<Json[]>(F, 'tracabilite/proprietes.json');
    const prix = props.find((p) => p.bien === ids.asset && p.champ === 'acquisitionPrice' && p.cible === `ASSET#${ids.asset}`)!;
    expect(prix, 'entrée acquisitionPrice').toBeDefined();
    expect(prix.verdict).toBe('VIDE_EN_BASE');
    expect(prix.persiste.fiche.valeur).toBeNull();
    // API / affichage : valeur renvoyée (vide) et champ d'écran.
    expect(prix.api).toMatchObject({ route: 'GET /api/assets/[id]/details', http: 200, renvoye: true, valeur: null });
    expect(prix.affichage.champs[0]).toMatchObject({ recuDeLApi: true, valeurLue: null });
    expect(parse<Json[]>(F, 'api-ui/fiches.json').find((x) => x.bien === ids.asset)).toMatchObject({ compte: A.id, http: 200 });
    const date = props.find((p) => p.bien === ids.asset && p.champ === 'acquisitionDate' && p.cible === `ASSET#${ids.asset}`)!;
    expect(date).toMatchObject({ verdict: 'COHERENT' });
    expect(date.persiste.canonique).toMatchObject({ valeur: '2021-09-14' });
    // Documents ; montant 490 000 € ; extractions ; faits ; unités sources ; preuve.
    expect(rows(F, 'asset_files').filter((d) => d.asset_id === ids.asset).map((d) => d.id).sort()).toEqual([ids.acte, ids.pret].sort());
    expect(rows(F, 'asset_files').find((d) => d.id === ids.acte)).toMatchObject({ retained_title: 'Acte de vente', amount_cents: 49000000 });
    expect(rows(F, 'document_extractions').find((x) => x.id === ids.exActe)).toMatchObject({ model: 'gemini-2.5-pro', prompt_version: 't1_analyze_document@v7', amount_cents: 49000000 });
    expect(prix.faits.map((f: Json) => [f.id, Number(f.value_number)])).toEqual([[ids.factPrix, 490000]]);
    expect(rows(F, 'document_source_units').find((u) => u.source_unit_id === 'p2-u1')?.content_text).toBe('Prix : 490 000,00 €');
    expect(prix.preuves.map((e: Json) => [e.id, e.document, e.page])).toEqual([[ids.evPrix, ids.acte, 2]]);
    // Décision T3 et reprise de propriété manquante (property_recovery_*).
    expect(prix.decisions[0]).toMatchObject({ id: ids.decPrix, action: 'request_ai_review', reason_code: 'AMBIGUOUS_SOURCE', evidence_ids: [ids.evPrix] });
    expect(prix.reprisesProprieteManquante[0]).toMatchObject({ id: ids.recDecision, decision: 'ABSTAINED', cause: 'AMBIGUOUS_SOURCES', write_outcome: 'NOT_WRITTEN' });
    expect(rows(F, 'property_recovery_runs').find((r) => r.id === ids.recRun)).toMatchObject({ status: 'ANSWERED', trigger_code: 'COH-MISSING-PROPERTIES' });
    expect(rows(F, 'property_recovery_decisions').find((r) => r.id === ids.recDecision)).toMatchObject({ run_id: ids.recRun });
    // Contrôles de cohérence : campagne (toutes colonnes au global), preuve de contrôle, autoréparation.
    expect(rows(F, 'coherence_campaigns').find((c) => c.id === ids.campaign)).toMatchObject({ status: 'COMPLETE', scope_account_ids: [A.id, B.id] });
    expect(rows(F, 'coherence_object_proofs').find((p) => p.object_id === ids.asset)).toMatchObject({ check_id: 'COH-MISSING-PROPERTIES', last_campaign_id: ids.campaign });
    expect(rows(F, 'coherence_repairs').find((r) => r.id === ids.repair)).toMatchObject({ outcome: 'INEFFECTIVE', service: 'property-recovery' });
    // Écritures.
    expect(date.ecritures[0]).toMatchObject({ id: ids.ecriture, outcome: 'written', new_value: '2021-09-14' });
    // Opération, composante et montant TCO tracé jusqu'au document.
    expect(rows(F, 'business_operations').find((o) => o.id === ids.op)).toMatchObject({ type_code: 'ACQUISITION', status: 'REALIZED' });
    expect(rows(F, 'business_operation_financial_components').find((c) => c.id === ids.component)).toMatchObject({ amount_minor: 49000000, currency: 'EUR' });
    const trace = parse<Json[]>(F, 'tracabilite/montants.json').find((t) => t.ligne.id === `c:${ids.component}` && t.assetId === ids.asset)!;
    expect(trace, 'trace du montant 490 000 €').toBeDefined();
    expect(trace.ligne).toMatchObject({ eurCents: 49000000 });
    expect(trace.chaine.find((s: Json) => s.etape === 'RAPPROCHEMENT').donnees.sources[0]).toMatchObject({ source_kind: 'DOCUMENT', source_entity_key: String(ids.acte) });
    expect(parse<Json[]>(F, 'tracabilite/tco.json').find((x) => x.assetId === ids.asset)).toMatchObject({ disponible: true });
    expect((parse<Json>(F, 'tracabilite/identite-economique.json').sources as Json[]).find((s) => s.id === ids.source)).toMatchObject({ nature_decision: 'CREATION' });
    // Jobs et appels IA (prompt : empreinte seulement), chronologie corrélée.
    expect(rows(F, 'ai_job_queue').find((j) => j.id === ids.job)).toMatchObject({ attempts: 2, last_error: 'tentative 1 : délai dépassé', status: 'DONE' });
    expect(rows(F, 'ai_usage_event').find((u) => u.id === ids.usage)).toMatchObject({ master_prompt_code: 'T1_MASTER', job_id: ids.job });
    expect(rows(F, 'ai_call_captures').find((c) => Number(c.usage_event_id) === ids.usage)?.prompt_text).toMatchObject({ $etat: 'masque', longueur: PROMPT_SECRET.length });
    expect(rows(F, 'ai_execution_report_entries').filter((e) => Number(e.report_id) === ids.report)).toHaveLength(1);
    const chrono = parse<Json[]>(F, 'technique/chronologie.json');
    expect(chrono.some((e) => e.table === 'ai_job_queue' && e.id === ids.job)).toBe(true);
    expect(chrono.some((e) => e.table === 'ai_usage_event' && e.id === ids.usage)).toBe(true);
    // Chaîne fermée : chaque référence résolue.
    const refs = parse<Json>(F, 'controle/references.json');
    expect(refs.totaux.absentes).toBe(0);
    const ref = (from: string, column: string) => (refs.references as Json[]).find((r) => r.from === from && r.column === column);
    expect(ref('reconciliation_decisions', 'evidence_ids')).toMatchObject({ resolues: 1, absentes: [] });
    expect(ref('property_recovery_decisions', 'evidence_ids')).toMatchObject({ resolues: 1, absentes: [] });
    expect(ref('document_facts', 'source_unit_ids')).toMatchObject({ resolues: 2, absentes: [] });
    // Versions et configuration : base, migrations.
    const v = parse<Json>(F, 'technique/versions.json');
    expect(v.migrations.appliquees).toBe(rows(F, '_migrations').length);
    expect(v.baseDeDonnees.version).toMatch(/^16/);
  });

  it('L91A-E03 RÈGLE : chaque diagnostic filtré est inclus dans le global ; isolation des filtres', async () => {
    await seConnecter('ADMIN');
    const { filteredIncludedInGlobal } = await import('@/services/admin/diagnostics-export/inclusion');
    for (const qs of [`scope=account&id=${A.id}`, `scope=user&id=${A.owner.id}`, `scope=asset&id=${ids.asset}`, `scope=document&id=${ids.acte}`, `scope=operation&id=${ids.op}`, `scope=account&id=${B.id}`]) {
      const z = await zip(qs);
      const m = parse(z.files, 'manifeste.json');
      // Global généré APRÈS le filtré : chaque génération ajoute sa propre ligne de suivi (admin_export_generations) —
      // le global de comparaison voit donc au moins tout ce que le filtré a vu.
      const g = await zip('scope=global');
      expect(filteredIncludedInGlobal(z.files, g.files).join('\n'), qs).toBe('');
      // Un filtre réduit le volume : jamais « non applicable parce que réservé au compte ».
      for (const s of m.sections as Json[]) {
        expect(['COMPLETE', 'NOT_APPLICABLE'], `${qs} ${s.code} : ${s.motif}`).toContain(s.status);
        if (s.status === 'NOT_APPLICABLE') expect(s.motif, qs).toMatch(/Ensemble de l’application/);
      }
      expect(m.status, qs).toBe('COMPLETE');
      // Isolation : aucune ligne d'un autre compte dans un filtre.
      const own = qs.includes(`id=${B.id}`) ? B.id : A.id;
      for (const [p, c] of Object.entries(z.files)) {
        if (!p.startsWith('donnees/')) continue;
        for (const r of JSON.parse(c) as Json[]) if (r && typeof r === 'object' && 'account_id' in r && r.account_id !== null) expect(r.account_id, `${qs} ${p}`).toBe(own);
      }
      expect(z.raw, qs).not.toContain(own === A.id ? 'Voiture Seconde L91A' : 'Maison L91A');
      // Filtres fins : la chaîne de l'objet est présente (lignes directes, enfants, fermeture).
      const has = (t: string, pred: (r: Json) => boolean = () => true) => expect(rows(z.files, t).some(pred), `${qs} › ${t}`).toBe(true);
      if (qs.startsWith('scope=asset') || qs === `scope=account&id=${A.id}`) {
        for (const t of ['assets', 'asset_files', 'document_extractions', 'document_facts', 'document_source_units', 'field_evidence', 'reconciliation_runs', 'reconciliation_decisions',
          'canonical_field_writes', 'property_recovery_runs', 'property_recovery_decisions', 'coherence_object_proofs', 'coherence_repairs', 'coherence_campaigns', 'business_operations',
          'business_operation_financial_components', 'business_operation_sources', 'ai_job_queue', 'ai_usage_event', 'ai_call_captures', 'ai_execution_reports', 'ai_execution_report_entries', 'accounts']) has(t);
        expect(parse<Json[]>(z.files, 'tracabilite/montants.json').some((t) => t.ligne.id === `c:${ids.component}`), qs).toBe(true);
        expect(parse<Json[]>(z.files, 'tracabilite/proprietes.json').some((p) => p.champ === 'acquisitionPrice' && p.bien === ids.asset), qs).toBe(true);
      }
      if (qs.startsWith('scope=document')) {
        has('asset_files', (r) => r.id === ids.acte);
        for (const t of ['document_facts', 'document_source_units', 'field_evidence', 'ai_job_queue', 'ai_usage_event', 'ai_execution_report_entries', 'business_operation_sources', 'assets']) has(t);
        expect(rows(z.files, 'asset_files').some((r) => r.id === ids.pret), 'autre document hors filtre').toBe(false);
      }
      if (qs.startsWith('scope=operation')) {
        for (const t of ['business_operations', 'business_operation_financial_components', 'business_operation_sources', 'business_operation_asset_links', 'assets', 'asset_files']) has(t);
        const lignes = parse<Json[]>(z.files, 'tracabilite/montants.json').map((t) => t.ligne);
        expect(lignes.map((l) => l.id), qs).toContain(`c:${ids.component}`);
        // Seules les lignes TCO liées à l'Opération (composante, ou document repris par elle).
        expect(lignes.every((l) => l.id === `c:${ids.component}` || l.operationId === ids.op), qs).toBe(true);
      }
    }
    // Un écart serait détecté : ligne modifiée ou fichier inconnu.
    const z = await zip(`scope=asset&id=${ids.asset}`);
    const altered = { ...z.files, 'donnees/etat-metier/assets.json': JSON.stringify((JSON.parse(z.files['donnees/etat-metier/assets.json']) as Json[]).map((a) => ({ ...a, name: 'ALTÉRÉ' }))), 'divers/nouveau.json': '[]' };
    const v = filteredIncludedInGlobal(altered, G.files);
    expect(v.join('\n')).toMatch(/assets › id=\d+ : colonne name différente/);
    expect(v.join('\n')).toMatch(/divers\/nouveau\.json : fichier d’une famille inconnue/);
  }, 600_000);

  it('L91A-E04 volume : parties part-NNNN (attendu = exporté par partie), même contenu que le fichier unique', async () => {
    const admin = await seConnecter('ADMIN');
    const { generateDiagnostic } = await import('@/services/admin/diagnostics-export/collect');
    const b = await generateDiagnostic({ scope: 'global', id: null, reinforced: false }, { adminUserId: admin.id, partRows: 3 });
    const files = Object.fromEntries(b.files.map((f) => [f.path, f.content]));
    const parts = b.manifest.files.filter((f) => f.part && f.part.group === 'donnees/etat-metier/users.json');
    expect(parts.length).toBeGreaterThan(1);
    for (const f of parts) {
      expect(f.path).toMatch(/^donnees\/etat-metier\/users\.part-\d{4}\.json$/);
      expect(f.count, f.path).toBe(f.expected);
      expect(f.status).toBe('COMPLETE');
    }
    const usersParts = rows(files, 'users').map((u) => u.id).sort((x, y) => x - y);
    const usersDb = (await sql<{ id: number }[]>`SELECT id FROM users ORDER BY id`).map((u) => u.id);
    expect(usersParts).toEqual(usersDb);
    // Mêmes lignes qu'au fichier unique de la route (utilisateurs créés depuis : en plus).
    expect(usersParts).toEqual(expect.arrayContaining(rows(G.files, 'users').map((u) => u.id)));
    expect(b.manifest.status).toBe('COMPLETE');
    expect(b.report).not.toMatch(/sur \?/);
    expect(b.manifest.warnings.join(' ')).not.toMatch(/sur \?/);
  }, 300_000);

  it('L91A-E05 sécurité : aucun secret au global ; exclusions déclarées', () => {
    expect(G.raw).not.toContain('HASH-SECRET-L91A');
    expect(G.raw).not.toContain('JETON-PARTAGE-L91A');
    expect(G.raw).not.toContain('sk-l91aFAKE');
    expect(G.raw).not.toContain('admin.l91a@example.fr');
    expect(G.raw).not.toContain(A.owner.email);
    const user = rows(G.files, 'users').find((u) => u.id === A.owner.id)!;
    expect('password_hash' in user).toBe(false);
    expect(user.email).toMatchObject({ $etat: 'masque', motif: 'e-mail' });
    expect(rows(G.files, 'admin_audit_log').find((r) => r.action_type === 'L91A_TEST')?.admin_email).toMatchObject({ $etat: 'masque', motif: 'e-mail' });
    const m = parse(G.files, 'manifeste.json');
    expect(m.exclusionsVolontaires.colonnes).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'users', colonne: 'password_hash' }), expect.objectContaining({ table: 'accounts', colonne: 'calendar_share_token' })]));
    expect(m.exclusionsVolontaires.tables).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'revoked_tokens', categorie: 'SECURITE' }), expect.objectContaining({ table: 'verebona_messages', categorie: 'CONTENU_PERSONNEL' })]));
    // Isolation sans objet au global : les colonnes multi-comptes y sont exportées (scope_account_ids ci-dessus) ; au filtre compte, omises.
    expect(m.exclusionsVolontaires.colonnes.some((c: Json) => c.table === 'coherence_campaigns')).toBe(false);
  });

  it('L91A-E06 auto-contrôle : référence pendante et compteur non détaillé → global PARTIAL, déclarés', async () => {
    await seConnecter('ADMIN');
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
              VALUES (${ids.run}, ${A.id}, ${ids.asset}, 'acquisitionPrice', 'ignore', 'L91A_PENDANTE', 'probable', true, '[987654321]'::jsonb)`;
    await sql`UPDATE ai_execution_reports SET counters = '{"factsPersisted": 4}'::jsonb WHERE id = ${ids.report}`;
    try {
      const z = await zip('scope=global');
      const m = parse(z.files, 'manifeste.json');
      expect(m.status).toBe('PARTIAL');
      const sec = (c: string) => (m.sections as Json[]).find((x) => x.code === c)!;
      expect(sec('conflits-arbitrages')).toMatchObject({ status: 'PARTIAL' });
      expect(sec('conflits-arbitrages').errors.join(' ')).toMatch(/reconciliation_decisions\.evidence_ids → field_evidence\.id absente/);
      expect(sec('extractions-ia').errors.join(' ')).toMatch(/factsPersisted/);
      expect(m.autoControle.references.absentes).toBe(1);
      expect(m.autoControle.compteursAnnonces.ecartsStricts).toBe(1);
      expect(m.autoControle.conclusion).toMatch(/Manques constatés/);
    } finally {
      await sql`DELETE FROM reconciliation_decisions WHERE reason_code = 'L91A_PENDANTE'`;
      await sql`UPDATE ai_execution_reports SET counters = '{"factsPersisted": 1}'::jsonb WHERE id = ${ids.report}`;
    }
  }, 300_000);

  it('L91A-E07 raccourci « Données du compte », anciens paramètres ignorés, périmètre inconnu, accès réservé', async () => {
    await seConnecter('ADMIN');
    const res = await appel(`scope=account&id=${A.id}&period=all&from=2020-01-01&to=2020-01-02&treatments=T9`);
    expect(res.status).toBe(200);
    const v = await res.json() as Json;
    expect(v.manifest.request).toEqual({ scope: 'account', id: A.id, reinforced: false, scopeLabel: 'Filtre : compte' });
    expect(v.manifest.couverture.horsFiltre.length).toBeGreaterThan(0);
    expect((await appel('scope=inconnu')).status).toBe(400);
    expect((await appel('scope=account&id=999999999')).status).toBe(404);
    await seConnecter('USER');
    expect((await appel('scope=global&format=zip')).status).toBe(403);
  }, 300_000);
});
