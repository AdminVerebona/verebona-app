/**
 * Lot 77C — BO › Supervision › « Diagnostics techniques » sur PostgreSQL 16
 * réel, PAR LA VRAIE ROUTE (garde `requireAdmin` réelle : seule la lecture
 * du cookie de session est simulée).
 *
 * Jeu « Tikamoon » (cas du ticket) : une commande Tikamoon de 490 000 € —
 * montant d'achat d'une maison — produite par les chemins de PRODUCTION :
 * persistance T1 réelle du candidat (indice financier ancré sur un fait
 * `document_facts`), consolidation T3 réelle (Opération, composante,
 * sources), TCO réel. S'y ajoutent les traces IA (extraction, rapport T1,
 * appel IA, diagnostic d'appel avec sortie), un job T1, une anomalie, et une
 * Opération SANS source (trace interrompue attendue).
 *
 *   · L77C-E01 accès administrateur seulement (403, aucune génération) ;
 *   · L77C-E02 périmètre Opération : rapport + ZIP lisible, JSON valides ;
 *     montant 490 000 € tracé Document → fait extrait → indice T1 → décision
 *     T3 → composante → sources → ligne TCO → affichage, modèle et version de
 *     prompt, rapport T1 et appel IA ; Opération sans source : « non
 *     disponible » explicite, jamais reconstruit ;
 *   · L77C-E03 périmètre bien : dossiers bien + équipements, même montant
 *     tracé depuis le TCO du bien ;
 *   · L77C-E04 périmètre document ; L77C-E05 utilisateur ; L77C-E06 global
 *     et filtre par traitement ;
 *   · L77C-E07 isolation : aucun objet d'un autre compte ; objet inconnu 404 ;
 *   · L77C-E08 journalisation de chaque demande (succès et échecs) ;
 *   · L77C-E09 masquage (secrets, e-mails, IBAN, adresse, fichier original) ;
 *   · L77C-E10 diagnostic renforcé : sorties modèle par l'accès existant
 *     (journalisé), refus si non autorisé ;
 *   · L77C-E11 aucune écriture métier (empreintes identiques).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

type Json = Record<string, unknown>;

scenario('L77C', 'BO Diagnostics techniques : périmètres, ZIP, traçabilité TCO Tikamoon, sécurité', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; });

  async function seConnecter(role: 'ADMIN' | 'USER') {
    const u = await make.user({ role });
    session.userId = u.id; session.role = role; session.email = u.email;
    return u;
  }
  let GET: (r: import('next/server').NextRequest) => Promise<Response>;
  let NextRequest: typeof import('next/server').NextRequest;
  const appel = (qs: string) => GET(new NextRequest(`http://app.test/api/admin/diagnostics?${qs}`));
  async function json(qs: string): Promise<{ manifest: Json; report: string; files: Array<{ path: string; bytes: number }> }> {
    const res = await appel(qs);
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  }
  async function zip(qs: string): Promise<{ files: Record<string, string>; raw: string; headers: Headers }> {
    const res = await appel(`${qs}&format=zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const files: Record<string, string> = {};
    for (const [name, f] of Object.entries(z.files)) if (!f.dir) files[name] = await f.async('string');
    // Toutes les données JSON sont valides.
    for (const [name, c] of Object.entries(files)) if (name.endsWith('.json')) expect(() => JSON.parse(c), name).not.toThrow();
    return { files, raw: Object.values(files).join('\n'), headers: res.headers };
  }
  const parse = <T = Json>(files: Record<string, string>, p: string): T => JSON.parse(files[p]) as T;

  const ids: Record<string, number> = {};
  let A: AccountRow & { owner: { id: number; email: string } };
  let B: AccountRow & { owner: { id: number; email: string } };

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    GET = (await import('@/app/api/admin/diagnostics/route')).GET as never;

    A = await make.account({ plan: 'premium', name: 'Compte Tikamoon E2E' });
    B = await make.account({ plan: 'premium', name: 'Compte Etranger L77C' });
    const maison = await make.asset(A, { category: 'IMMOBILIER', name: 'Maison Lilas', keyCharacteristics: { address1: '12 rue des Lilas', address1__origin: 'USER' } });
    ids.asset = maison.id;
    ids.equipment = (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${maison.id}, 'Table Tikamoon', 'FURNITURE') RETURNING id`)[0].id;

    // Document « Commande Tikamoon » : T1 a lu 490 000 € (prix de la maison) — fait persisté, puis candidat ancré sur ce fait.
    const f = await make.assetFile(A, { assetId: maison.id, name: 'acte-vente-dupont.pdf' });
    ids.file = f.id;
    await sql`UPDATE asset_files SET retained_title = 'Commande Tikamoon', document_date = '2026-03-02', amount_cents = 49000000, supplier = 'Tikamoon',
                     filename = 'acte-vente-dupont.pdf', original_filename = 'Acte Dupont.pdf', extracted_text = 'TEXTE INTÉGRAL ACTE DE VENTE',
                     notes = 'Contact jean.dupont@example.fr IBAN FR76 3000 6000 0112 3456 7890 189', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    ids.extraction = (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, amount_cents, currency, document_date, supplier_name, full_text, provider, model, prompt_version, operation_trace_id)
      VALUES (${A.id}, ${f.id}, 49000000, 'EUR', '2026-03-02', 'Tikamoon', 'TEXTE INTÉGRAL ACTE DE VENTE', 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v5', 'tr-l77c-tika')
      RETURNING id`)[0].id;
    ids.fact = Number((await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, raw_value, confidence, excerpt, status, provider, model, prompt_version)
      VALUES (${A.id}, ${f.id}, ${ids.extraction}, 'totalAmount', 'totalAmount', 'Prix de vente', 490000, 'EUR', '490 000,00 €', 'certain', 'Prix de vente : 490 000,00 €', 'active', 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v5')
      RETURNING id`)[0].id);
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: A.id, fileId: f.id, extractionId: ids.extraction, analysisRunId: null, reanalysis: false,
        candidates: [cand({ typeHint: 'ACQUISITION', summary: 'Commande Tikamoon', provider: 'Tikamoon', targetHints: [cible(maison.id)],
          businessReferences: [ref('ORDER', 'TK-490')], temporalHints: { realizedDate: '2026-03-02' }, financialHints: [fh('REALIZED_COST', 49_000_000, { factRef: 'f1' } as never)], evidenceFactRefs: ['f1'] })],
        facts: new Map([['f1', [{ factId: ids.fact, sourceUnitIds: ['u-prix'] }]]]),
      });
    });
    ids.candidate = Number((await sql<{ id: number }[]>`SELECT id FROM document_operation_candidates WHERE file_id = ${f.id} AND status = 'ACTIVE'`)[0].id);
    await k.passer(A);   // T3 réel : Opération, composante, sources.
    const [op] = await k.actives(A);
    ids.op = op.id;
    ids.component = (await k.composantes(op.id))[0].id;

    // Traces IA et journaux.
    ids.job = (await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, trigger_code, attempts, last_error, finished_at)
      VALUES ('T1', ${A.id}, 'asset_file', ${String(f.id)}, ${`l77c-t1-${f.id}`}, 'DONE', 'source_uploaded', 1, NULL, now()) RETURNING id`)[0].id;
    ids.usage = (await sql<{ id: number }[]>`
      INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, status, input_tokens, output_tokens, metadata, job_id, operation_code, environment)
      VALUES (${A.id}, ${f.id}, 'extraction', 'gemini', 'gemini-2.5-pro', 'success', 1200, 300,
              ${JSON.stringify({ traceId: 'tr-l77c-tika', promptVersion: 't1_analyze_document@v5', providerRequest: { apiKey: 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE' } })}::jsonb, ${ids.job}, 't1.analyze', 'test')
      RETURNING id`)[0].id;
    ids.report = Number((await sql<{ id: number }[]>`
      INSERT INTO ai_execution_reports (account_id, treatment, scope, job_id, trace_ids, file_id, asset_id, extraction_id, status, entry_count)
      VALUES (${A.id}, 'T1', 'DOCUMENT', ${ids.job}, ${['tr-l77c-tika']}, ${f.id}, ${maison.id}, ${ids.extraction}, 'SUCCESS', 1) RETURNING id`)[0].id);
    await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, table_name, record_id, field_key, value, write_result)
              VALUES (${ids.report}, 1, ${A.id}, 'FACT', 'document_facts', ${String(ids.fact)}, 'totalAmount', '490000'::jsonb, 'WRITTEN')`;
    await sql`INSERT INTO ai_call_diagnostics (trace_id, usage_event_id, call_index, account_id, operation_code, model, outcome, source_ids, raw_output, parsed_output, output_chars, contract_version)
              VALUES ('tr-l77c-tika', ${ids.usage}, 0, ${A.id}, 't1.analyze', 'gemini-2.5-pro', 'SUCCEEDED', ${[f.id]}, '{"total": 49000000, "contact": "jean.dupont@example.fr"}',
                      ${JSON.stringify({ total: 49000000 })}::jsonb, 52, 5)`;
    await sql`INSERT INTO admin_anomalies (domain, fingerprint, title, account_id) VALUES ('ai', ${`l77c-${A.id}`}, 'T1 : montant incohérent (E2E)', ${A.id})`;

    // Opération SANS source (saisie hors document, montant sans origine tracée).
    ids.opSansSource = (await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date)
      VALUES (${A.id}, 'INTERVENTION', 'REALIZED', 'Entretien sans justificatif', 'Inconnu', '2026-04-01') RETURNING id::int AS id`)[0].id;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${A.id}, ${ids.opSansSource}, ${maison.id}, 'PRIMARY', 'STRUCTURED')`;
    ids.compSansSource = (await sql<{ id: number }[]>`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency) VALUES (${A.id}, ${ids.opSansSource}, 'REALIZED_COST', 15000, 'EUR') RETURNING id::int AS id`)[0].id;

    // Compte B (isolation).
    const autre = await make.asset(B, { name: 'Bien Etranger L77C' });
    ids.assetB = autre.id;
    ids.fileB = (await make.assetFile(B, { assetId: autre.id })).id;
    ids.opB = (await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label) VALUES (${B.id}, 'OTHER', 'REALIZED', 'Operation Etrangere L77C') RETURNING id::int AS id`)[0].id;
    await sql`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status) VALUES ('T3', ${B.id}, 'business_operations', ${String(B.id)}, ${`l77c-b-${B.id}`}, 'FAILED')`;
    for (const key of Object.keys(ids)) ids[key] = Number(ids[key]);
  });

  /** Empreinte des tables métier des comptes de test (aucune écriture attendue). */
  async function empreinte(): Promise<string> {
    const acc = `account_id IN (${A.id}, ${B.id})`;
    const tables: Array<[string, string]> = [
      ['assets', acc], ['equipments', `asset_id IN (SELECT id FROM assets WHERE ${acc})`], ['asset_files', acc], ['document_extractions', acc],
      ['document_facts', acc], ['document_operation_candidates', acc], ['field_evidence', acc], ['canonical_field_writes', acc],
      ['business_operations', acc], ['business_operation_sources', acc], ['business_operation_financial_components', acc], ['business_operation_history', acc],
      ['agenda_items', acc], ['to_process_actions', acc], ['ai_job_queue', acc], ['ai_execution_reports', acc], ['ai_usage_event', acc], ['admin_anomalies', acc],
    ];
    const out: string[] = [];
    for (const [t, w] of tables) {
      const [r] = await sql.unsafe(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x WHERE ${w}`);
      out.push(`${t}=${r.n}:${r.h}`);
    }
    return out.join('\n');
  }
  let avant = '';
  it('(empreinte initiale)', async () => { avant = await empreinte(); });

  it('L77C-E01 accès réservé aux administrateurs : 403 pour un utilisateur, aucune génération', async () => {
    await seConnecter('USER');
    for (const qs of ['scope=global', `scope=operation&id=${ids.op}`, `scope=asset&id=${ids.asset}&format=zip`]) {
      expect((await appel(qs)).status).toBe(403);
    }
    expect((await sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_user_id = ${session.userId}`)[0].n).toBe(0);
  });

  it('L77C-E02 Opération Tikamoon : 490 000 € tracé jusqu’à sa source ; Opération sans source « non disponible »', async () => {
    await seConnecter('ADMIN');
    const v = await json(`scope=operation&id=${ids.op}`);
    expect(v.report).toContain('VEREBONA — DIAGNOSTIC TECHNIQUE');
    expect(v.report).toMatch(/Environnement {4}: \S+/);
    expect(v.report).toContain('Version          :');
    expect(v.report).toContain(`Opération #${ids.op}`);
    expect(v.report).toContain('490 000,00 €');
    expect(v.report).toMatch(/Valeurs : source=.*490000.* \| proposée IA=.*49000000.* \| enregistrée=.*49000000/);
    expect(v.manifest).toMatchObject({ schema: 'verebona.bo.diagnostic-technique/1', request: { scope: 'operation', id: ids.op }, target: { accountIds: [A.id] } });

    const z = await zip(`scope=operation&id=${ids.op}`);
    expect(z.headers.get('content-disposition')).toMatch(new RegExp(`attachment; filename="verebona-diagnostic-operation-${ids.op}-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]{8}\\.zip"`));
    for (const p of ['rapport.txt', 'manifeste.json', `metier/operation-${ids.op}.json`, `metier/documents/document-${ids.file}.json`, 'tracabilite/montants.json',
      'tracabilite/tco.json', 'logs/traitements-file.json', 'logs/chronologie.json', 'ia/rapports-execution.json', 'ia/appels.json', 'ia/extractions.json', 'contexte-technique.json']) {
      expect(z.files[p], p).toBeDefined();
    }
    const traces = parse<Array<Json & { chaine: Array<Json & { etape: string; statut: string; references: Array<{ table: string; id: number }>; donnees?: Json }>; valeurs: Json; ligne: Json; rupture: string | null; assetId: number }>>(z.files, 'tracabilite/montants.json');
    const t = traces.find((x) => x.ligne.id === `c:${ids.component}` && x.assetId === ids.asset)!;
    expect(t, 'trace de la composante 490 000 €').toBeDefined();
    const etape = (e: string) => t.chaine.find((s) => s.etape === e)!;
    expect(t.chaine.map((s) => s.etape)).toEqual(['DOCUMENT', 'EXTRACTION_IA', 'DECISION', 'ENREGISTREMENT', 'RAPPROCHEMENT', 'CALCUL', 'AFFICHAGE']);
    // Document source.
    expect(etape('DOCUMENT')).toMatchObject({ statut: 'disponible', references: [{ table: 'asset_files', id: ids.file }] });
    expect(etape('DOCUMENT').donnees).toMatchObject({ retained_title: 'Commande Tikamoon', amount_cents: 49000000, supplier: 'Tikamoon' });
    // Extraction IA : fait désigné par l'indice T1, modèle, version de prompt, rapport T1, appel IA.
    const ext = etape('EXTRACTION_IA');
    expect(ext.statut).toBe('disponible');
    expect(ext.references).toEqual(expect.arrayContaining([
      { table: 'document_extractions', id: ids.extraction }, { table: 'document_facts', id: ids.fact },
      { table: 'ai_execution_reports', id: ids.report }, { table: 'ai_usage_event', id: ids.usage },
    ]));
    // Lot 78A : lien composante → candidat → indice → fait PERSISTÉ par T3 (plus de correspondance de valeur).
    expect(ext.donnees).toMatchObject({
      modele: { modele: 'gemini-2.5-pro', versionPrompt: 't1_analyze_document@v5', trace: 'tr-l77c-tika' },
      candidatDesignePar: 'business_operation_financial_component_sources.evidence (lien persisté par T3)',
      lienPersiste: { candidat: ids.candidate, indices: [0], faits: [ids.fact] },
    });
    expect((ext.donnees!.indicesFinanciers as Json[])[0]).toMatchObject({ amountMinor: 49000000, justifieLaComposante: true, evidence: { factId: ids.fact } });
    // Décision T3, enregistrement, rapprochement, calcul, affichage.
    expect(etape('DECISION')).toMatchObject({ statut: 'disponible', donnees: { t3: { issue: 'CREATE_NEW', operationRetenue: ids.op } } });
    expect(etape('ENREGISTREMENT')).toMatchObject({ statut: 'disponible', donnees: { composante: { id: ids.component, amount_minor: 49000000, currency: 'EUR' }, operation: { provider: 'Tikamoon' } } });
    expect((etape('RAPPROCHEMENT').donnees!.sources as Json[])[0]).toMatchObject({ source_kind: 'DOCUMENT', source_entity_key: String(ids.file), authority: 'DOCUMENT' });
    expect(etape('CALCUL')).toMatchObject({ statut: 'disponible', donnees: { retenuCents: 49000000 } });
    expect(etape('AFFICHAGE')).toMatchObject({ statut: 'disponible', donnees: { visible: true } });
    expect(t.rupture).toBeNull();
    // Les quatre valeurs distinctes du ticket.
    expect(t.valeurs).toMatchObject({
      source: [{ fait: ids.fact, valeur: 490000, brute: '490 000,00 €' }], proposeeIA: { amountMinor: 49000000, role: 'REALIZED_COST' },
      enregistree: { montantMinor: 49000000, devise: 'EUR' }, calculee: { retenuCents: 49000000 }, affichee: { retenuCents: 49000000 },
    });

    // Opération sans source : rupture au document, motif explicite, rien de reconstruit.
    const z2 = await zip(`scope=operation&id=${ids.opSansSource}`);
    const [t2] = parse<Array<Json & { chaine: Array<Json & { etape: string; statut: string; motif?: string }>; rupture: string | null; valeurs: Json }>>(z2.files, 'tracabilite/montants.json');
    expect(t2.rupture).toBe('DOCUMENT');
    expect(t2.chaine[0]).toMatchObject({ etape: 'DOCUMENT', statut: 'non_disponible' });
    expect(t2.chaine[0].motif).toMatch(/aucune source enregistrée/);
    expect(t2.chaine.find((s) => s.etape === 'DECISION')).toMatchObject({ statut: 'non_disponible' });
    expect(t2.valeurs).toMatchObject({ source: null, proposeeIA: null, enregistree: { montantMinor: 15000 } });
    expect(z2.files['rapport.txt']).toContain('Rupture de la trace : Document source');
    expect(parse<{ unavailable: Json[] }>(z2.files, 'manifeste.json').unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ element: expect.stringContaining('Traçabilité de 1 montant') })]));
  });

  it('L77C-E03 bien et équipements : dossiers, TCO, même montant tracé depuis le bien', async () => {
    await seConnecter('ADMIN');
    const z = await zip(`scope=asset&id=${ids.asset}`);
    expect(z.files[`metier/bien-${ids.asset}.json`]).toBeDefined();
    expect(z.files[`metier/equipements/equipement-${ids.equipment}.json`]).toBeDefined();
    const tco = parse<Json[]>(z.files, 'tracabilite/tco.json');
    expect(tco[0]).toMatchObject({ assetId: ids.asset, disponible: true });
    const traces = parse<Array<Json & { ligne: Json; rupture: string | null }>>(z.files, 'tracabilite/montants.json');
    expect(traces.find((x) => x.ligne.id === `c:${ids.component}`)).toMatchObject({ rupture: null, ligne: { includedCents: 49000000 } });
    expect(traces.find((x) => x.ligne.id === `c:${ids.compSansSource}`)).toMatchObject({ rupture: 'DOCUMENT' });
    // Ligne documentaire reprise par l'Opération : tracée, masquée sur la fiche (motif).
    const doc = traces.find((x) => x.ligne.id === `doc:${ids.file}` || String(x.ligne.id).startsWith(`doc:${ids.file}:`)) as (Json & { chaine: Array<Json & { etape: string; donnees?: Json }> }) | undefined;
    expect(doc, JSON.stringify(traces.map((x) => [x.ligne.id, x.ligne.status, x.ligne.reason]))).toBeDefined();
    expect(doc!.chaine.find((s) => s.etape === 'AFFICHAGE')!.donnees).toMatchObject({ visible: false });
    expect(parse<Json[]>(z.files, 'logs/traitements-file.json').map((j) => j.id)).toContain(ids.job);
    expect(parse<Json[]>(z.files, 'logs/anomalies-supervision.json').map((a) => a.title)).toContain('T1 : montant incohérent (E2E)');
  });

  it('L77C-E04 document : dossier, montants liés au document, traces IA du document', async () => {
    await seConnecter('ADMIN');
    const z = await zip(`scope=document&id=${ids.file}`);
    expect(z.files[`metier/document-${ids.file}.json`]).toBeDefined();
    const traces = parse<Array<Json & { ligne: Json }>>(z.files, 'tracabilite/montants.json');
    expect(traces.map((x) => x.ligne.id)).toContain(`c:${ids.component}`);
    expect(traces.map((x) => x.ligne.id)).not.toContain(`c:${ids.compSansSource}`);   // sans rapport avec le document
    expect(parse<Json[]>(z.files, 'ia/appels.json').map((c) => c.id)).toContain(ids.usage);
    expect(parse<Json[]>(z.files, 'ia/diagnostics-appels.json')[0]).toMatchObject({ trace_id: 'tr-l77c-tika', sortie_conservee: true, contract_version: 5 });
    expect(parse<Json[]>(z.files, 'ia/rapports-execution-lignes.json')[0]).toMatchObject({ report_id: ids.report, section: 'FACT', record_id: String(ids.fact) });
  });

  it('L77C-E05 utilisateur : comptes, biens, e-mail pseudonymisé', async () => {
    await seConnecter('ADMIN');
    const z = await zip(`scope=user&id=${A.owner.id}`);
    const u = parse<{ utilisateur: Json; comptes: Json[]; biens: Json[] }>(z.files, 'metier/utilisateur.json');
    expect(u.utilisateur).toMatchObject({ id: A.owner.id, email: { $etat: 'masque', motif: 'e-mail' } });
    expect(u.comptes.map((c) => c.id)).toEqual([A.id]);
    expect(u.biens.map((b) => b.id)).toContain(ids.asset);
    expect(z.raw).not.toContain(A.owner.email);
  });

  it('L77C-E06 global et filtre par traitement', async () => {
    await seConnecter('ADMIN');
    const z = await zip('scope=global&treatments=T1');
    expect(parse<Json>(z.files, 'metier/volumetrie.json')).toHaveProperty('volumetrie');
    const jobs = parse<Json[]>(z.files, 'logs/traitements-file.json');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.treatment === 'T1')).toBe(true);
    expect(z.files['ia/appels-agreges.json']).toBeDefined();
    expect(z.files['rapport.txt']).toContain('Traitements      : T1');
    // Filtres invalides : 400, jamais de requête libre.
    expect((await appel('scope=global&treatments=T9')).status).toBe(400);
    expect((await appel('scope=asset')).status).toBe(400);
    // Lot 81C : plus de borne de 366 jours (période longue et « tout l'historique » acceptées) ; dates invalides : 400.
    expect((await appel('scope=global&from=2020-01-01&to=2026-01-01')).status).toBe(200);
    expect((await appel('scope=global&from=2026-01-02&to=2026-01-01')).status).toBe(400);
  });

  it('L77C-E07 isolation : aucun objet d’un autre compte ; objet inconnu 404', async () => {
    await seConnecter('ADMIN');
    for (const qs of [`scope=operation&id=${ids.op}`, `scope=asset&id=${ids.asset}`, `scope=document&id=${ids.file}`, `scope=user&id=${A.owner.id}`]) {
      const z = await zip(qs);
      expect(z.raw, qs).not.toContain('Bien Etranger L77C');
      expect(z.raw, qs).not.toContain('Operation Etrangere L77C');
      expect(z.raw, qs).not.toContain(`l77c-b-${B.id}`);
      const m = parse<{ target: { accountIds: number[] } }>(z.files, 'manifeste.json');
      expect(m.target.accountIds).toEqual([A.id]);
      for (const p of ['logs/traitements-file.json', 'ia/appels.json', 'ia/rapports-execution.json', 'logs/anomalies-supervision.json']) {
        expect(parse<Json[]>(z.files, p).every((r) => r.account_id === undefined || r.account_id === A.id), `${qs} ${p}`).toBe(true);
      }
    }
    expect((await appel('scope=operation&id=999999999')).status).toBe(404);
    expect((await appel('scope=asset&id=999999998')).status).toBe(404);
  });

  it('L77C-E08 chaque demande est journalisée (consultation, ZIP, échecs)', async () => {
    const admin = await seConnecter('ADMIN');
    await json(`scope=document&id=${ids.file}`);
    await zip(`scope=document&id=${ids.file}`);
    await appel('scope=operation&id=999999997');
    await appel('scope=global&treatments=T9');
    const rows = await sql<{ action_type: string; target_type: string; target_id: number | null; result: string; details: string }[]>`
      SELECT action_type, target_type, target_id, result, details FROM admin_audit_log WHERE admin_user_id = ${admin.id} ORDER BY id`;
    expect(rows.map((r) => [r.action_type, r.result])).toEqual([
      ['TECH_DIAGNOSTIC_VIEW', 'SUCCESS'], ['TECH_DIAGNOSTIC_EXPORT', 'SUCCESS'], ['TECH_DIAGNOSTIC_VIEW', 'FAILURE'], ['TECH_DIAGNOSTIC_VIEW', 'FAILURE'],
    ]);
    expect(rows.every((r) => r.target_type === 'TECH_DIAGNOSTIC')).toBe(true);
    const d = JSON.parse(rows[1].details);
    expect(d).toMatchObject({ scope: 'document', id: ids.file, format: 'zip', accounts: [A.id] });
    expect(d.generationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.fileName).toMatch(/\.zip$/);
    expect(JSON.parse(rows[2].details)).toMatchObject({ code: 'TARGET_NOT_FOUND' });
    expect(JSON.parse(rows[3].details)).toMatchObject({ code: 'INVALID_TREATMENT' });
  });

  it('L77C-E09 masquage : secrets, e-mails, IBAN, adresse, fichier original, texte intégral', async () => {
    await seConnecter('ADMIN');
    for (const qs of [`scope=asset&id=${ids.asset}`, `scope=document&id=${ids.file}`, `scope=user&id=${A.owner.id}`, 'scope=global']) {
      const z = await zip(qs);
      for (const leak of ['jean.dupont@example.fr', A.owner.email, '0112 3456 7890', '12 rue des Lilas', 'acte-vente-dupont', 'Acte Dupont.pdf',
        `e2e/${A.id}/`, 'TEXTE INTÉGRAL ACTE', 'AIzaSyFAKE', 'password_hash', 'e2e-non-connectable']) {
        expect(z.raw, `${qs} : ${leak}`).not.toContain(leak);
      }
    }
  });

  it('L77C-E10 diagnostic renforcé : sorties modèle via l’accès existant (journalisé) ; refus si non autorisé', async () => {
    const admin = await seConnecter('ADMIN');
    const z = await zip(`scope=document&id=${ids.file}&reinforced=1`);
    const sorties = parse<Json[]>(z.files, 'ia/sorties-modele.json');
    expect(sorties[0]).toMatchObject({ trace: 'tr-l77c-tika', appel: ids.usage, modele: 'gemini-2.5-pro', sortieStructuree: { total: 49000000 } });
    expect(String(sorties[0].sortieBrute)).toContain('49000000');
    expect(z.raw).not.toContain('jean.dupont@example.fr');
    expect((await sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type = 'AI_MODEL_OUTPUT_READ' AND result = 'SUCCESS'`)[0].n).toBe(1);
    // Sans diagnostic renforcé : aucune sortie modèle.
    expect((await zip(`scope=document&id=${ids.file}`)).files['ia/sorties-modele.json']).toBeUndefined();
    // Liste restreinte qui n'inclut pas cet administrateur : refus explicite et journalisé.
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = '999999';
    try {
      const z2 = await zip(`scope=document&id=${ids.file}&reinforced=1`);
      expect(parse<Json[]>(z2.files, 'ia/sorties-modele.json')).toEqual([]);
      expect(parse<{ unavailable: Json[] }>(z2.files, 'manifeste.json').unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ element: 'Diagnostic renforcé', motif: expect.stringContaining('refusé') })]));
      expect((await sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND action_type = 'AI_MODEL_OUTPUT_READ' AND result = 'DENIED'`)[0].n).toBe(1);
    } finally {
      delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS;
    }
  });

  it('L77C-E11 aucune écriture métier : empreintes identiques après toutes les générations', async () => {
    expect(await empreinte()).toBe(avant);
  });
});
