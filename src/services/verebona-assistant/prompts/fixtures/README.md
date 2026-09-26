# Fixtures de prompts (CDC §17.9 / §35)

Les cas de référence exécutables vivent désormais dans
`src/services/verebona-assistant/eval/` (`cases.ts` + runner vitest) et dans
les tests de contrat des prompts maîtres
(`src/services/ai/prompts/__tests__/contrat-*.test.ts`).

Toute modification d'un prompt maître ou d'une consigne de tâche
(`prompts/*.ts`, registre `registries/prompt-registry.ts`) doit laisser ces
deux jeux au vert.
