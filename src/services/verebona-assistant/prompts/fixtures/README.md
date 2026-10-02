# Fixtures de prompts (CDC §17.9 / §35)

Les cas de référence exécutables vivent désormais dans
`src/services/verebona-assistant/eval/` (`cases.ts` + runner vitest), dans
les tests de contrat du prompt maître T2
(`src/services/ai/prompts/__tests__/contrat-*.test.ts`) et dans le corpus
master (`npm run ai:corpus`).

Depuis le lot 16b-2, l'assistant n'a plus qu'un prompt : le master T2
(`src/services/ai/prompts/assistant/t2_master_v1.txt`). Les consignes de
tâche par intention (`prompts/*.ts`) et le registre
`registries/prompt-registry.ts` sont supprimés ; seule la règle de format
par intention (`prompts/answer-format.ts`) reste, appliquée par le
validateur. Toute modification du master doit laisser ces jeux au vert.
