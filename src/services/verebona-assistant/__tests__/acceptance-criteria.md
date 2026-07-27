# Critères d'acceptation — suivi CA-01 → CA-30 (CDC §36)

| # | Critère (résumé) | Vérifié par | Statut |
|---|---|---|---|
| CA-01 | Drawer ouvrable desktop + mobile, accessible clavier | e2e + axe | ☐ |
| CA-02 | Recherche classique fonctionne pour toutes les offres | eval `search-*` | ☐ |
| CA-03 | Réponse IA uniquement offres éligibles | eval `std-summary-blocked` | ☐ |
| CA-04 | Aucune requête ne sérialise l'ensemble du compte | revue + test retrieval | ☐ |
| CA-05 | Aide produit répond sans IA | eval `help-*` | ☐ |
| CA-06 | Sortie IA validée par schéma serveur | test response-validator | ☐ |
| CA-07 | ≤ 2 appels Gemini par message | compteur usage-tracking | ☐ |
| CA-08 | Sources affichées + « Pourquoi ? » | e2e sources/explanation | ☐ |
| CA-09 | Contradictions signalées, rien inventé | eval dédié | ☐ |
| CA-10 | Actions issues du catalogue fermé | test action-resolver | ☐ |
| CA-11 | Historique 7 j purgé + effacement manuel | test conversation.service | ☐ |
| CA-12 | Suggestions issues d'un catalogue | test capability-registry | ☐ |
| CA-13 | Clarification ≤ 2 étapes, expiration 30 min | e2e clarifications | ☐ |
| CA-14 | Rate limit 10/min appliqué | test route messages | ☐ |
| CA-15 | Aucune fuite inter-comptes | eval `isolation` | ☐ |
| CA-16 | Injection documentaire neutralisée | test prompt-builder | ☐ |
| CA-17 | Réponses toujours en français | eval locale | ☐ |
| CA-18 | Repli déterministe si IA échoue | test orchestrateur | ☐ |
| CA-19 | Idempotence (clientRequestId) | test conversation.service | ☐ |
| CA-20 | Tokens/coûts/modèle tracés | test usage-tracking | ☐ |
| CA-21 | Champ ≤ 2 000 caractères | test composer/route | ☐ |
| CA-22 | Escalade modèle contrôlée | test gemini-router | ☐ |
| CA-23 | Une seule demande active | test hook/machine | ☐ |
| CA-24 | Redaction données sensibles avant contexte | test redaction | ☐ |
| CA-25 | Rollback modèle/prompt sans redéploiement | test registres | ☐ |
| CA-26 | Cache invalidé par événement métier | test invalidation | ☐ |
| CA-27 | Timeouts 3/12/20 s respectés | test orchestrateur | ☐ |
| CA-28 | Circuit breaker Gemini | test gemini-router | ☐ |
| CA-29 | store=false vérifié | test provider + config | ☐ |
| CA-30 | Alias jamais "latest" | test config startup | ☐ |
