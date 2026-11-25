/**
 * Carte Trello #837 (C3) — empreinte du CODE RÉEL des prédicats de règles T1
 * (garde de livraison, exécutée par les tests).
 *
 * Le corps de chaque fonction listée dans `T1_RULE_PREDICATES` est extrait des
 * sources par le compilateur TypeScript, IMPRIMÉ SANS COMMENTAIRES (mise en
 * forme normalisée par l'imprimante du compilateur) puis haché : une
 * modification de commentaire ou d'indentation ne change rien, une
 * modification de la logique change l'empreinte.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

/** Texte normalisé (sans commentaires) d'une fonction déclarée au niveau du module ; null si introuvable. */
export function predicateText(source: string, fn: string): string | null {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === fn) return printer.printNode(ts.EmitHint.Unspecified, st, sf);
  }
  return null;
}

/**
 * Empreinte de l'ensemble des prédicats (pure si `read` l'est). `read` : lecture
 * d'un fichier source (remplaçable pour simuler une modification).
 */
export function predicatesSignature(
  predicates: ReadonlyArray<{ file: string; fn: string }>,
  read: (file: string) => string = (f) => readFileSync(f, 'utf8'),
): { signature: string; missing: string[] } {
  const missing: string[] = [];
  const parts = predicates.map(({ file, fn }) => {
    const t = predicateText(read(file), fn);
    if (t === null) missing.push(`${file}#${fn}`);
    return `${file}#${fn}\u0002${t ?? ''}`;
  });
  return { signature: createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32), missing };
}

/** La garde : la version courante a-t-elle enregistré l'empreinte du code en vigueur ? */
export function rulesGuardViolation(p: {
  version: number; recorded: Readonly<Record<number, string>>; current: string;
}): string | null {
  const attendu = p.recorded[p.version];
  if (attendu === undefined) return `version ${p.version} : aucune empreinte de prédicats enregistrée`;
  if (attendu !== p.current) {
    return `prédicats de règles T1 modifiés (empreinte ${p.current}, enregistrée ${attendu}) : incrémenter T1_COVERAGE_RULES_VERSION `
      + 'et enregistrer la nouvelle empreinte dans T1_RULES_PREDICATE_SIGNATURES (le stock sera réévalué)';
  }
  return null;
}
