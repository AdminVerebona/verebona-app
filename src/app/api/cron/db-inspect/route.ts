/**
 * GET /api/cron/db-inspect — inspection du schéma, en lecture seule.
 *
 * Placée sous `/api/cron/` et non `/api/admin/` : le middleware exige une
 * session sur les routes d'administration, et le diagnostic doit rester
 * accessible même quand l'authentification est justement ce qui ne fonctionne
 * plus. Les routes planifiées s'authentifient par `CRON_SECRET`, ce qui
 * convient exactement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ROUTE DE DIAGNOSTIC TEMPORAIRE
 *
 * Elle existe parce qu'une base d'hébergement n'est joignable ni depuis un
 * poste — accès Internet fermé — ni par une console web, l'offre n'en
 * proposant pas. Le seul canal disponible est le déploiement lui-même.
 *
 * ⚠️ À RETIRER une fois le diagnostic établi. Elle n'a pas vocation à rester :
 * une route qui décrit le schéma d'une base renseigne un attaquant sur ce
 * qu'il peut chercher, même sans lui en donner le contenu.
 *
 * ── CE QU'ELLE NE FAIT PAS ────────────────────────────────────────────────
 *
 * Aucune écriture, aucun DDL, aucune donnée applicative. Elle lit
 * `_migrations` et `information_schema` — c'est-à-dire des NOMS de tables et
 * de colonnes, jamais leur contenu. Pas une ligne de compte, de document ou
 * de paiement ne transite par ici.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';

export const dynamic = 'force-dynamic';

/** Tables dont l'existence répond à la question posée. */
const TABLES_SURVEILLEES = [
  // Socle : si elles manquent, le problème est bien plus large.
  'users', 'accounts', 'asset_files', 'assets',
  // Créée par 0050 — si elle existe alors que 0050 échoue, le schéma a été
  // posé sans son journal.
  'agenda_items',
  // Créée par 0072 — c'est elle que référencent 0115, 0116 et 0117.
  'account_subscriptions',
  // Créées par mes migrations 0115 à 0119.
  'legal_document_versions', 'legal_acceptances', 'legal_audit_log',
  'scheduled_account_deletions', 'withdrawal_requests', 'withdrawal_events',
  'document_categories',
  // Créées par les migrations 0101 à 0107 du socle IA.
  'ai_use_case_registry', 'field_evidence', 'reconciliation_runs',
];

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const rapport: Record<string, unknown> = {};

  // ── Version du serveur ────────────────────────────────────────────────
  try {
    const [v] = await pgClient<{ version: string }[]>`SELECT version()`;
    rapport.postgresql = v.version.split(' ').slice(0, 2).join(' ');
  } catch (e) {
    rapport.postgresql = `illisible : ${(e as Error).message}`;
  }

  // ── Journal des migrations ────────────────────────────────────────────
  try {
    const lignes = await pgClient<{ filename: string; applied_at: Date }[]>`
      SELECT filename, applied_at FROM _migrations ORDER BY filename
    `;
    rapport.migrationsEnregistrees = {
      total: lignes.length,
      fichiers: lignes.map((l) => l.filename),
    };
  } catch (e) {
    const code = (e as { code?: string }).code;
    rapport.migrationsEnregistrees =
      code === '42P01'
        ? { total: 0, absente: true, note: 'La table _migrations n’existe pas.' }
        : { erreur: `${code ?? 'sans code'} : ${(e as Error).message}` };
  }

  // ── Tables présentes ──────────────────────────────────────────────────
  try {
    const lignes = await pgClient<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const presentes = new Set(lignes.map((l) => l.table_name));

    rapport.tables = {
      total: presentes.size,
      surveillees: Object.fromEntries(
        TABLES_SURVEILLEES.map((t) => [t, presentes.has(t)]),
      ),
    };
  } catch (e) {
    rapport.tables = { erreur: (e as Error).message };
  }

  // ── Colonnes ajoutées par mes migrations ──────────────────────────────
  //
  // Une table peut exister sans les colonnes qu'une migration devait y
  // ajouter : c'est la seconde forme du désalignement, invisible autrement.
  try {
    const lignes = await pgClient<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'users' AND column_name IN ('feature_flags', 'has_seen_upload_notice'))
       OR (table_name = 'asset_files' AND column_name IN ('classification_state', 'document_category_id'))
       OR (table_name = 'account_subscriptions' AND column_name = 'contract_concluded_at')
       OR (table_name = 'signup_contexts' AND column_name IN ('user_id', 'account_id'))
        )
      ORDER BY table_name, column_name
    `;
    rapport.colonnesAttendues = lignes.map((l) => `${l.table_name}.${l.column_name}`);
  } catch (e) {
    rapport.colonnesAttendues = { erreur: (e as Error).message };
  }

  return NextResponse.json(rapport, { status: 200 });
}
