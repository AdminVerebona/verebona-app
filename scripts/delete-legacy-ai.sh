#!/usr/bin/env bash
#
# Suppression physique des moteurs IA historiques — CDC §8 et §9.7.
#
# ⚠️ À N'EXÉCUTER QU'APRÈS la période de stabilité du §10.3, et une fois les cinq
# flags positionnés à `enabled` en production depuis au moins six semaines.
#
# Le script est idempotent : un fichier déjà supprimé n'est pas une erreur.
# Chaque suppression doit produire une ligne dans docs/ai/PREUVE-SUPPRESSION.md.

set -euo pipefail

echo "── Suppression des moteurs IA historiques ──────────────────────────────"

remove() {
  if [ -e "$1" ]; then
    git rm -q "$1"
    echo "  ✓ supprimé : $1"
  else
    echo "  · déjà absent : $1"
  fi
}

echo
echo "Services et bibliothèques (8)"
remove "src/lib/gemini-search.ts"                                  # usage 6
remove "src/lib/intelligent-search.ts"                             # usage 7
remove "src/services/document-ai/apply-ai-suggestions.ts"          # usages 3 et 4
remove "src/services/document-ai/enrich-and-coherence.service.ts"  # usage 5
remove "src/services/document-ai/gemini-client.ts"                 # couche modèles
remove "src/services/document-ai/upload-to-gemini.ts"              # Files API
remove "src/services/document-ai/unified-analysis-pipeline.ts"     # orchestrateur
remove "src/services/agenda/AgendaClassificationService.ts"        # usage 8

echo
echo "Routes API (3)"
remove "src/app/api/assets/[id]/ai-suggestions/route.ts"           # usage 3
remove "src/app/api/search/intelligent/route.ts"                   # usage 7
remove "src/app/api/admin/ai-instructions/apply/route.ts"          # usage 11

echo
echo "Prompts historiques (14)"
for p in asset_suggest_v1 enrich_coherence_v1 intelligent_search_v1 search_v1 \
         equipment_link_v1 extract_v1 extract_meta_v1 extract_detail_v1 \
         extract_full_v1 extract_agenda_v1 agenda_detect_v1 detect_groups_v1 \
         intent_detect_v1 title_coherence_v1; do
  remove "src/services/document-ai/prompts/${p}.txt"
done

echo
echo "── Vérification ────────────────────────────────────────────────────────"
npm run typecheck
node scripts/check-legacy-ai.mjs --phase=7
npx tsx scripts/ai-inventory.ts

echo
echo "✓ Suppression terminée. Complétez docs/ai/PREUVE-SUPPRESSION.md avec les"
echo "  numéros de commit avant de prononcer la bascule réglementaire."
