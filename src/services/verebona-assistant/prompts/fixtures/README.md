# Fixtures de prompts (CDC §17.9 / §35)

Chaque prompt versionné possède un jeu de cas de référence (entrée → sortie attendue)
servant à la non-régression avant toute modification. À compléter en Phase 3/4.

Convention : `<prompt-id>.fixtures.ts` exportant `Array<{ name, input, expected }>`.
