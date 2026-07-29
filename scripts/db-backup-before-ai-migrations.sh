#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Sauvegarde obligatoire avant le premier déploiement du socle IA.
#
# POURQUOI. Les migrations 0101 à 0111 sont appliquées automatiquement par
# `ensureMigrations()` au démarrage de l'application. Il n'y a donc pas d'étape
# manuelle où l'on pourrait s'apercevoir d'un problème : le déploiement et la
# migration sont le même geste.
#
# La 0107 est la seule qui RÉÉCRIT des données existantes : elle convertit les
# clés `<champ>_origin` de `assets.key_characteristics` au format `<champ>__origin`.
# Elle est idempotente et n'écrase jamais une clé déjà migrée, mais une erreur
# d'interprétation reviendrait à traiter une saisie utilisateur comme une valeur
# automatique — donc à autoriser son écrasement par l'IA. C'est le point le plus
# risqué du chantier.
#
# UTILISATION
#   ./scripts/db-backup-before-ai-migrations.sh            # sauvegarde
#   ./scripts/db-backup-before-ai-migrations.sh --verify   # contrôle post-migration
#
# Requiert DATABASE_URL et pg_dump (client PostgreSQL 16+).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL doit être défini}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTDIR="${BACKUP_DIR:-./backups}"
DUMP="${OUTDIR}/verebona-pre-ai-${STAMP}.dump"
ASSETS_CSV="${OUTDIR}/assets-key-characteristics-${STAMP}.csv"

mkdir -p "$OUTDIR"

if [[ "${1:-}" == "--verify" ]]; then
  echo "── Contrôle post-migration ───────────────────────────────────────────"

  echo "Migrations appliquées :"
  psql "$DATABASE_URL" -Atc \
    "SELECT filename FROM _migrations WHERE filename ~ '^01(0|1)' ORDER BY filename"

  echo
  echo "Tables du socle IA présentes :"
  psql "$DATABASE_URL" -Atc \
    "SELECT tablename FROM pg_tables
      WHERE schemaname='public'
        AND tablename IN ('ai_use_cases','ai_operations','field_evidence',
                          'ai_operation_idempotency','ai_model_pricing')
      ORDER BY tablename"

  echo
  echo "Conversion 0107 — biens portant encore une clé au format ancien :"
  psql "$DATABASE_URL" -Atc \
    "SELECT count(*) FROM assets
      WHERE deleted_at IS NULL
        AND key_characteristics::jsonb::text ~ '\"[a-z_]+_origin\"'
        AND key_characteristics::jsonb::text !~ '\"[a-z_]+__origin\"'"

  echo
  echo "Lignes converties, par valeur d'origine :"
  psql "$DATABASE_URL" -Atc \
    "SELECT migrated_value, count(*) FROM field_origin_migration_audit
      GROUP BY migrated_value ORDER BY 2 DESC"

  echo
  echo "Catalogue tarifaire (0 ⇒ coûts non mesurables, cf. question 3 du métier) :"
  psql "$DATABASE_URL" -Atc "SELECT count(*) FROM ai_model_pricing"

  echo
  echo "✓ Contrôle terminé. Un compte non nul à la troisième requête signale une"
  echo "  conversion incomplète : NE PAS activer de drapeau IA, restaurer."
  exit 0
fi

echo "── Sauvegarde avant migrations IA 0101→0111 ──────────────────────────"
echo "Cible : $DUMP"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file "$DUMP"

# Extraction ciblée de la colonne réécrite par la 0107 : permet un retour
# arrière champ par champ sans restaurer toute la base.
psql "$DATABASE_URL" -c "\copy (
  SELECT id, account_id, key_characteristics
    FROM assets
   WHERE deleted_at IS NULL AND key_characteristics IS NOT NULL
) TO '${ASSETS_CSV}' WITH CSV HEADER"

echo
echo "✓ Sauvegarde complète : $DUMP ($(du -h "$DUMP" | cut -f1))"
echo "✓ Colonne 0107 isolée : $ASSETS_CSV ($(wc -l < "$ASSETS_CSV") lignes)"
echo
echo "Restauration :"
echo "  pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" \"$DUMP\""
echo
echo "Déployez ensuite, puis relancez ce script avec --verify."
