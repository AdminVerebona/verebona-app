/**
 * #851 — Jeu de données de l'audit de performance (base JETABLE et LOCALE).
 *
 *   PERF_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres \
 *     npx tsx scripts/perf-audit-851-seed.ts [--base verebona_perf851] [--echelle 1]
 *
 * 1. Construit la base comme le harnais E2E (schéma Drizzle + toutes les
 *    migrations SQL : `bootstrapE2eDatabase`, même chemin que la CI).
 * 2. Peuple un compte « gros client » mesuré (identifiants ci-dessous) et des
 *    comptes « bruit » (autres clients) : un index manquant ne se voit que si
 *    la table contient aussi les lignes des autres comptes.
 *
 * Écriture SQL directe par `generate_series` (quelques secondes), comme les
 * fabriques E2E (`src/test/e2e/factories.ts`) : aucune IA, aucun réseau,
 * aucun service applicatif. Refuse tout serveur non local (garde du harnais).
 *
 * Compte mesuré (échelle 1) : 40 biens (10 logements, 15 véhicules, 15
 * objets), 50 pièces, 110 équipements, 4 000 documents (dont 400 en
 * rattachement secondaire), 40 000 faits, 3 000 événements d'Agenda,
 * 1 500 Opérations (sources, biens, événements liés), 150 fournisseurs,
 * 300 questions « À traiter » ouvertes, 500 mises à jour IA.
 * Bruit : 60 comptes × (5 biens, 300 documents, 3 000 faits, 200 événements).
 * Plateforme (`--plateforme 2000`) : 2 000 comptes de 10 biens sans document
 * (20 000 biens, 1 % TRANSMIS) — volume des tables partagées par tous les
 * comptes, dont dépend le coût d'un parcours séquentiel.
 */
import bcrypt from 'bcrypt';
import postgres from 'postgres';
import { bootstrapE2eDatabase, withDatabase } from '../src/test/e2e/db-bootstrap';

export const PERF_EMAIL = 'perf851@test.invalid';
export const PERF_ADMIN_EMAIL = 'perf851-admin@test.invalid';
export const PERF_PASSWORD = 'Perf851-audit!';

function arg(nom: string, defaut: string): string {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut;
}

const TYPES: Array<[string, string, string]> = [
  // [document_type_code v2, rubric_code, document_type v1]
  ['ACQUISITION_INVOICE', 'PROPERTY_MANAGEMENT', 'FACTURE'],
  ['OTHER_EQUIPMENT_FURNITURE', 'EQUIPMENT_FURNITURE', 'AUTRE'],
  ['SERVICE_CONTRACT', 'CONTRACTS_WARRANTIES_DOCS', 'CONTRAT'],
  ['MAINTENANCE_INVOICE', 'MAINTENANCE_WORKS', 'FACTURE'],
  ['INSURANCE_POLICY', 'INSURANCE_CLAIMS', 'ATTESTATION_ASSURANCE'],
  ['BUILDING_PERMIT', 'COMPLIANCE_CONTROLS', 'PERMIS_CONSTRUIRE'],
  ['PHOTO', 'MEDIA', 'PHOTO'],
  ['RENTAL_LEASE', 'RENTAL_MANAGEMENT', 'CONTRAT'],
  ['OTHER_DOCUMENT', 'OTHER_DOCUMENTS', 'AUTRE'],
];

/** Peuple un compte. `n` : volumes. Rend l'identifiant du compte. */
async function peuplerCompte(sql: postgres.Sql, opts: {
  email: string; passwordHash: string; nom: string; plan: string;
  biens: number; documents: number; faitsParDoc: number; evenements: number; operations: number;
  fournisseurs: number; questions: number; majIa: number; role?: string;
}): Promise<{ accountId: number; userId: number }> {
  const [u] = await sql<{ id: number }[]>`
    INSERT INTO users (email, password_hash, status, is_active, first_name, last_name, role,
                       accepted_terms_at, created_at)
    VALUES (${opts.email}, ${opts.passwordHash}, 'ACTIVE', true, 'Audit', ${opts.nom}, ${opts.role ?? 'USER'},
            now() - interval '400 days', now() - interval '400 days')
    RETURNING id`;
  const [a] = await sql<{ id: number }[]>`
    INSERT INTO accounts (name, owner_user_id, created_at)
    VALUES (${opts.nom}, ${u.id}, now() - interval '400 days') RETURNING id`;
  await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${a.id}, ${u.id}, 'owner', 'active')`;
  await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, first_billed_at)
            VALUES (${a.id}, ${opts.plan}, 'active', now() - interval '390 days')`;
  const acc = a.id; const usr = u.id;

  // Biens : 1/4 logements, 3/8 véhicules, 3/8 objets.
  await sql`
    INSERT INTO assets (user_id, account_id, category, name, purchase_date, purchase_price_cents, created_at,
                        address, city, postal_code, registration_number)
    SELECT ${usr}, ${acc},
           CASE WHEN g % 8 < 2 THEN 'IMMOBILIER' WHEN g % 8 < 5 THEN 'VEHICULE' ELSE 'OBJET' END,
           'Bien ' || g, date '2015-01-01' + (g * 37 % 3000), 100000 + g * 12345,
           now() - (g || ' days')::interval,
           CASE WHEN g % 8 < 2 THEN g || ' rue de l''Audit' END, CASE WHEN g % 8 < 2 THEN 'Lyon' END,
           CASE WHEN g % 8 < 2 THEN '69003' END, CASE WHEN g % 8 BETWEEN 2 AND 4 THEN 'AB-' || lpad(g::text, 3, '0') || '-CD' END
    FROM generate_series(1, ${opts.biens}) g`;
  const biens = await sql<{ id: number; category: string }[]>`SELECT id, category FROM assets WHERE account_id = ${acc} ORDER BY id`;
  const ids = biens.map((b) => b.id);
  const logements = biens.filter((b) => b.category === 'IMMOBILIER').map((b) => b.id);

  // Pièces (5 par logement) et équipements (8 par logement, 2 par véhicule).
  await sql`INSERT INTO substructures (asset_id, name, order_index, room_type)
            SELECT a, 'Pièce ' || g, g, 'ROOM' FROM unnest(${logements}::int[]) a, generate_series(1, 5) g`;
  await sql`INSERT INTO equipments (asset_id, name, type, category)
            SELECT a, 'Équipement ' || g, 'APPLIANCE', 'EQUIPMENT' FROM unnest(${logements}::int[]) a, generate_series(1, 8) g`;
  const vehicules = biens.filter((b) => b.category === 'VEHICULE').map((b) => b.id);
  await sql`INSERT INTO equipments (asset_id, name, type, category)
            SELECT a, 'Accessoire ' || g, 'ACCESSORY', 'EQUIPMENT' FROM unnest(${vehicules}::int[]) a, generate_series(1, 2) g`;

  // Fournisseurs.
  await sql`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, city)
            SELECT ${acc}, ${usr}, 'Fournisseur ' || g, 'fournisseur ' || g, 'Lyon' FROM generate_series(1, ${opts.fournisseurs}) g`;

  // Documents : répartis sur les biens, 9 rubriques, 10 ans de dates.
  const types = TYPES;
  await sql`
    INSERT INTO asset_files (user_id, account_id, asset_id, linked_asset_id, filename, original_filename, mime_type,
                             file_extension, size, sha256_hash, s3_key, upload_status, document_type, document_type_code,
                             rubric_code, classification_state, document_date, supplier, amount_cents, retained_title,
                             description, analysis_state, last_analysis_at, uploaded_at, created_at, updated_at,
                             extracted_text)
    SELECT ${usr}, ${acc}, (${ids}::int[])[1 + g % ${ids.length}], (${ids}::int[])[1 + g % ${ids.length}],
           'doc-' || g || '.pdf', 'Document ' || g || '.pdf', 'application/pdf', 'pdf', 50000 + g * 13,
           md5(${acc}::text || '-' || g), 'perf/' || ${acc} || '/' || g || '.pdf', 'COMPLETED',
           (${types.map((t) => t[2])}::text[])[1 + g % 9], (${types.map((t) => t[0])}::text[])[1 + g % 9],
           (${types.map((t) => t[1])}::text[])[1 + g % 9], 'CLASSIFIED',
           date '2016-01-01' + (g * 7 % 3650), 'Fournisseur ' || (1 + g % ${opts.fournisseurs}), 1000 + (g * 97 % 500000),
           'Document ' || g || ' — ' || (${types.map((t) => t[0])}::text[])[1 + g % 9],
           'Description du document ' || g, 'ANALYZED', now() - (g % 700 || ' days')::interval,
           now() - (g % 700 || ' days')::interval, now() - (g % 700 || ' days')::interval, now() - (g % 700 || ' days')::interval,
           repeat('Texte extrait du document ' || g || '. ', 40)
    FROM generate_series(1, ${opts.documents}) g`;
  await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
            SELECT account_id, id, asset_id, 'PRIMARY', 'AI', 'ACTIVE' FROM asset_files WHERE account_id = ${acc}
            ON CONFLICT DO NOTHING`; // un déclencheur crée déjà le lien principal
  // 10 % des documents concernent aussi un second bien.
  await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
            SELECT account_id, id, (${ids}::int[])[1 + (id + 1) % ${ids.length}], 'SECONDARY', 'AI', 'ACTIVE'
            FROM asset_files WHERE account_id = ${acc} AND id % 10 = 0
              AND (${ids}::int[])[1 + (id + 1) % ${ids.length}] <> asset_id
            ON CONFLICT DO NOTHING`;
  // Extractions et faits.
  await sql`INSERT INTO document_extractions (account_id, file_id, asset_id_at_analysis, source_version, title, document_date,
                                              supplier_name, amount_cents, full_text, full_text_chars, document_type_code,
                                              rubric_code, fact_count)
            SELECT account_id, id, asset_id, 1, retained_title, document_date, supplier, amount_cents, extracted_text,
                   length(extracted_text), document_type_code, rubric_code, ${opts.faitsParDoc}
            FROM asset_files WHERE account_id = ${acc}`;
  await sql`
    INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value,
                                confidence, excerpt, evidence_origin, status, canonical_key, value_type, created_at)
    SELECT e.account_id, e.file_id, e.id, 'fait_' || k, 'Fait ' || k, 'Valeur ' || k || ' / ' || e.file_id,
           'valeur ' || k, 'certain', 'Extrait ' || k, 'TEXT_EXTRACTION', 'active', 'fait.' || k, 'TEXT', e.created_at
    FROM document_extractions e, generate_series(1, ${opts.faitsParDoc}) k
    WHERE e.account_id = ${acc}`;

  // Événements d'Agenda : passé et futur, quelques sans date ; 1 ou 2 biens.
  await sql`
    INSERT INTO agenda_items (account_id, created_by_user_id, title, description, start_date, end_date, manual_status,
                              origin_type, occurrence_nature, situation, no_deadline, created_at, updated_at, event_nature)
    SELECT ${acc}, ${usr}, 'Événement ' || g, 'Description ' || g,
           CASE WHEN g % 20 = 0 THEN NULL ELSE current_date - 1800 + (g * 11 % 2400) END,
           NULL, CASE WHEN g % 7 = 0 THEN 'realise' END,
           CASE WHEN g % 3 = 0 THEN 'qualified_document' ELSE 'manual' END,
           CASE WHEN g % 9 = 0 THEN 'FORECAST' ELSE 'CONFIRMED' END,
           CASE WHEN g % 5 = 0 THEN 'A_PREVOIR' END, g % 20 = 0,
           now() - (g % 500 || ' days')::interval, now() - (g % 500 || ' days')::interval,
           CASE WHEN g % 2 = 0 THEN 'DEADLINE' ELSE 'HISTORICAL' END
    FROM generate_series(1, ${opts.evenements}) g`;
  await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id)
            SELECT id, (${ids}::int[])[1 + id % ${ids.length}] FROM agenda_items WHERE account_id = ${acc}`;
  await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id)
            SELECT id, (${ids}::int[])[1 + (id + 3) % ${ids.length}] FROM agenda_items
            WHERE account_id = ${acc} AND id % 6 = 0 AND (id + 3) % ${ids.length} <> id % ${ids.length}`;
  await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id)
            SELECT ai.id, f.id FROM agenda_items ai
            JOIN LATERAL (SELECT id FROM asset_files WHERE account_id = ${acc} ORDER BY id OFFSET (ai.id % ${opts.documents}) LIMIT 1) f ON true
            WHERE ai.account_id = ${acc} AND ai.origin_type = 'qualified_document'`;

  // Opérations, sources (documents), biens concernés, événements liés.
  await sql`
    INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, planned_date, realized_date, created_at)
    SELECT ${acc}, (ARRAY['INTERVENTION','CONTRACT','ACQUISITION','CLAIM','FINANCING'])[1 + g % 5],
           CASE WHEN g % 4 = 0 THEN 'ENVISAGED' ELSE 'REALIZED' END, 'Opération ' || g, 'Fournisseur ' || (1 + g % ${opts.fournisseurs}),
           CASE WHEN g % 4 = 0 THEN current_date + (g % 300) END,
           CASE WHEN g % 4 <> 0 THEN current_date - (g % 2000) END, now() - (g % 600 || ' days')::interval
    FROM generate_series(1, ${opts.operations}) g`;
  await sql`
    INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority)
    SELECT account_id, id, (${ids}::int[])[1 + id::int % ${ids.length}], 'PRIMARY', 'DOCUMENT' FROM business_operations WHERE account_id = ${acc}`;
  await sql`
    INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority, confidence)
    SELECT o.account_id, o.id, 'DOCUMENT', 'asset_file:' || f.id, 'INVOICE', 'DOCUMENT', 'certain'
    FROM (SELECT id, account_id, row_number() OVER (ORDER BY id) rn FROM business_operations WHERE account_id = ${acc}) o
    JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM asset_files WHERE account_id = ${acc}) f
      ON f.rn IN (o.rn, o.rn + ${opts.operations})`;
  await sql`
    UPDATE agenda_items ai SET business_operation_id = o.id, projection_origin = 'OPERATION', operation_role = 'PRINCIPAL'
    FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM business_operations WHERE account_id = ${acc}) o,
         (SELECT id, row_number() OVER (ORDER BY id) rn FROM agenda_items WHERE account_id = ${acc}) x
    WHERE x.id = ai.id AND x.rn = o.rn`;
  await sql`INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, reason_code, evidence)
            SELECT account_id, business_operation_id, id, 'ACTIVE', 'SYSTEM', 'PERF_851', '[]'::jsonb FROM agenda_items
            WHERE account_id = ${acc} AND business_operation_id IS NOT NULL
            ON CONFLICT DO NOTHING`; // déjà créé par déclencheur à la pose de business_operation_id

  // À traiter : questions ouvertes sur les biens.
  await sql`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, priority, question, created_at)
    SELECT ${acc}, 'ASSET', (${ids}::int[])[1 + g % ${ids.length}], 'champ_' || g, 'COMPLETE', 'PERF_851',
           (ARRAY['DO_FIRST','DO_NEXT','CAN_WAIT'])[1 + g % 3], 'Question ' || g || ' ?', now() - (g || ' hours')::interval
    FROM generate_series(1, ${opts.questions}) g`;
  // Mises à jour IA de la fiche.
  await sql`
    INSERT INTO ai_field_updates (account_id, asset_id, asset_file_id, field_key, old_value, new_value, created_at)
    SELECT ${acc}, f.asset_id, f.id, 'purchase_price_cents', NULL, '1000', now() - (f.id % 300 || ' hours')::interval
    FROM asset_files f WHERE f.account_id = ${acc} ORDER BY f.id LIMIT ${opts.majIa}`;
  return { accountId: acc, userId: usr };
}

async function main() {
  const adminUrl = process.env.PERF_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
  const base = arg('base', 'verebona_perf851');
  const echelle = Number(arg('echelle', '1'));
  const plateforme = Number(arg('plateforme', '2000'));
  const t0 = Date.now();
  await bootstrapE2eDatabase({ adminUrl, database: base, log: (m) => console.log(m) });
  console.log(`[seed] base ${base} construite en ${Date.now() - t0} ms`);
  const sql = postgres(withDatabase(adminUrl, base), { max: 1, onnotice: () => undefined });
  try {
    const hash = await bcrypt.hash(PERF_PASSWORD, 10);
    const t1 = Date.now();
    const mesure = await peuplerCompte(sql, {
      email: PERF_EMAIL, passwordHash: hash, nom: 'Compte audit 851', plan: 'premium',
      biens: 40 * echelle, documents: 4000 * echelle, faitsParDoc: 10, evenements: 3000 * echelle,
      operations: 1500 * echelle, fournisseurs: 150, questions: 300, majIa: 500,
    });
    for (let i = 1; i <= 60; i += 1) {
      await peuplerCompte(sql, {
        email: `perf851-bruit-${i}@test.invalid`, passwordHash: 'perf851-non-connectable', nom: `Bruit ${i}`, plan: 'standard',
        biens: 5, documents: 300, faitsParDoc: 10, evenements: 200, operations: 60, fournisseurs: 20, questions: 10, majIa: 20,
      });
    }
    if (plateforme > 0) {
      await sql`
        WITH u AS (INSERT INTO users (email, password_hash, status)
                   SELECT 'perf851-plateforme-' || g || '@test.invalid', 'perf851-non-connectable', 'ACTIVE'
                   FROM generate_series(1, ${plateforme}) g RETURNING id),
             a AS (INSERT INTO accounts (name, owner_user_id) SELECT 'Plateforme ' || id, id FROM u RETURNING id, owner_user_id),
             m AS (INSERT INTO account_memberships (account_id, user_id, role, status)
                   SELECT id, owner_user_id, 'owner', 'active' FROM a RETURNING account_id)
        INSERT INTO assets (user_id, account_id, category, name, status)
        SELECT a.owner_user_id, a.id, 'OBJET', 'Objet ' || g, CASE WHEN g = 10 AND a.id % 10 = 0 THEN 'TRANSMIS' ELSE 'EN_SERVICE' END
        FROM a, generate_series(1, 10) g`;
    }
    const [adm] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status, is_active, role, first_name, last_name, accepted_terms_at)
      VALUES (${PERF_ADMIN_EMAIL}, ${hash}, 'ACTIVE', true, 'ADMIN', 'Admin', 'Audit', now()) RETURNING id`;
    await sql`ANALYZE`;
    const vol = await sql<{ t: string; n: number }[]>`
      SELECT relname AS t, n_live_tup::int AS n FROM pg_stat_user_tables
      WHERE relname IN ('assets','asset_files','document_facts','agenda_items','business_operations','to_process_actions',
                        'document_asset_links','agenda_asset_links','business_operation_sources','equipments','substructures','suppliers')
      ORDER BY relname`;
    console.log(`[seed] peuplé en ${Date.now() - t1} ms — compte mesuré ${mesure.accountId} (utilisateur ${mesure.userId}), admin ${adm.id}`);
    for (const v of vol) console.log(`[seed]   ${v.t.padEnd(28)} ${v.n}`);
    console.log(JSON.stringify({ base, accountId: mesure.accountId, userId: mesure.userId, adminId: adm.id }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
