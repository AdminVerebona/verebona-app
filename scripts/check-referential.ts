/**
 * Contrôle d'intégrité du référentiel V2 — CDC V2.0 §13.2.
 *
 * « Le code doit refuser au build/test une configuration où un Type
 *   appartient à plusieurs Rubriques. »
 *
 * Les tests couvrent déjà ces contrôles, mais un test peut être ignoré, et le
 * référentiel est modifié par des gens qui n'ouvriront pas `vitest` pour
 * ajouter un Type. Ce script est branché en CI avant le build : il coûte
 * quelques millisecondes et sort en échec explicite plutôt qu'en anomalie
 * d'affichage trois semaines plus tard.
 *
 *   npm run referential:check
 */
import { checkReferentialIntegrity, DOCUMENT_TYPES, REFERENTIAL_VERSION, RUBRICS } from '../src/lib/referential/v2';
import { checkRulesCatalog, PROCESSING_RULES } from '../src/services/to-process/rules-catalog';

const referentialViolations = checkReferentialIntegrity();
const catalogProblems = checkRulesCatalog();

console.log(`Référentiel documentaire V2 — version ${REFERENTIAL_VERSION}`);
console.log(`  ${RUBRICS.length} Rubriques, ${DOCUMENT_TYPES.length} Types`);
console.log(`  ${PROCESSING_RULES.length} règles de traitement`);

if (referentialViolations.length === 0 && catalogProblems.length === 0) {
  console.log('\n✓ Aucune anomalie.');
  process.exit(0);
}

console.error('\n✗ Anomalies détectées :\n');
for (const violation of referentialViolations) {
  console.error(`  · [${violation.code}] ${violation.message}`);
}
for (const problem of catalogProblems) {
  console.error(`  · [RULES] ${problem}`);
}
process.exit(1);
