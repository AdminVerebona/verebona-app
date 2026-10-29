/**
 * Lot 99B — correction DÉTERMINISTE d'un prompt maître (pure, sans base).
 *
 *   · point de départ : le texte et la configuration d'exécution de la
 *     version ACTIVE réelle — jamais un modèle générique ;
 *   · modification minimale : le bloc OFFICIEL du guide du PO inséré (ou
 *     substitué) à son ancre, exactement comme le PO le ferait et comme les
 *     tests du guide le rejouent ; tout le reste du texte est conservé octet
 *     pour octet (vérifié par le diff) ;
 *   · refus explicite, sans correction : ancre introuvable ou ambiguë, bloc
 *     déjà présent en partie (texte propre au PO), zone remplacée qui
 *     contiendrait une autre branche, un emplacement {{…}} ou le marqueur
 *     d'un autre contrat (texte trop divergent) ;
 *   · vérification de compatibilité EFFECTIVE, pas seulement du marqueur :
 *     contrôles bloquants du BO (rendu de chaque branche, emplacements,
 *     configuration d'exécution), emplacements et branches conservés, aucun
 *     autre contrat perdu, contrat visé satisfait, exemples JSON du bloc
 *     validés par la résolution déterministe de la passerelle.
 */
import type { Treatment } from '../config/treatments';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';
import type { ContractCheck, CorrectionStep, PromptContract } from './contracts';
import type { GuideBlock } from './guide-blocks';

export type CorrectionRefusal =
  | 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS' | 'ALREADY_PARTIALLY_PRESENT' | 'TEXT_TOO_DIVERGENT'
  | 'NO_OFFICIAL_BLOCK' | 'BLOCK_UNAVAILABLE' | 'NOTHING_TO_CHANGE';

export interface DiffLine { op: ' ' | '+' | '-'; line: string }
export interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }

export interface AppliedStep {
  kind: 'block' | 'execution';
  blockId?: string;
  action?: string;
  anchor?: string | null;
  skipped?: string;
  executionBefore?: MasterExecutionConfig;
  executionAfter?: MasterExecutionConfig;
}

export type CorrectionResult =
  | {
    ok: true; text: string; execution: MasterExecutionConfig; steps: AppliedStep[];
    diff: { added: number; removed: number; hunks: DiffHunk[]; unified: string };
  }
  | { ok: false; code: CorrectionRefusal; message: string; steps: AppliedStep[] };

const norm = (t: string) => t.replace(/\r\n?/g, '\n');
const lignes = (t: string) => norm(t).split('\n');

/** Indices (début de ligne, en caractères) des lignes qui vérifient le prédicat. */
function lineStarts(text: string, pred: (l: string) => boolean): number[] {
  const out: number[] = [];
  let pos = 0;
  for (const l of text.split('\n')) {
    if (pred(l)) out.push(pos);
    pos += l.length + 1;
  }
  return out;
}

/** Première ligne non vide d'un bloc (en-tête : sert à repérer un bloc déjà présent en partie). */
const enTete = (b: GuideBlock) => b.text.split('\n').find((l) => l.trim())?.trim() ?? '';

const refus = (code: CorrectionRefusal, message: string, steps: AppliedStep[]): CorrectionResult => ({ ok: false, code, message, steps });

/** Garde-fous d'une zone remplacée : aucune branche, aucun emplacement, aucun marqueur d'un autre contrat. */
function zoneProtegee(zone: string, protectedMarkers: readonly string[]): string | null {
  const branche = /^\s*BRANCHE\s+(TASK|MODE)\s*=.*$/m.exec(zone);
  if (branche) return `la zone remplacée contient la section « ${branche[0].trim()} »`;
  const empl = /\{\{[A-Z_]+\}\}/.exec(zone);
  if (empl) return `la zone remplacée contient l’emplacement ${empl[0]}`;
  const m = protectedMarkers.find((x) => x && zone.includes(x));
  return m ? `la zone remplacée contient le marqueur « ${m} » d’un autre contrat` : null;
}

/** Applique UN bloc officiel au texte (pur). */
export function applyBlock(text: string, b: GuideBlock, protectedMarkers: readonly string[]): { ok: true; text: string } | { ok: false; code: CorrectionRefusal; message: string } {
  const t = norm(text);
  const tete = enTete(b);
  if (b.action === 'insert-before' || b.action === 'replace-line') {
    const anchor = (b.anchor ?? '').trim();
    const pos = lineStarts(t, (l) => l.trim() === anchor);
    if (pos.length === 0) return { ok: false, code: 'ANCHOR_NOT_FOUND', message: `Ligne repère introuvable dans le texte actif : « ${anchor} ».` };
    if (pos.length > 1) return { ok: false, code: 'ANCHOR_AMBIGUOUS', message: `Ligne repère présente ${pos.length} fois : « ${anchor} ».` };
    if (b.action === 'insert-before') {
      if (tete && lineStarts(t, (l) => l.trim() === tete).length) {
        return { ok: false, code: 'ALREADY_PARTIALLY_PRESENT', message: `Le texte actif contient déjà la ligne « ${tete.slice(0, 120)} » du bloc sans en porter le contrat : texte propre au PO, une insertion le dupliquerait.` };
      }
      return { ok: true, text: `${t.slice(0, pos[0])}${b.text}\n\n${t.slice(pos[0])}` };
    }
    const fin = t.indexOf('\n', pos[0]);
    return { ok: true, text: `${t.slice(0, pos[0])}${b.text}${fin < 0 ? '' : t.slice(fin)}` };
  }
  // replace-from-to : `from` (ligne commençant par) incluse, `to` (ligne) exclue.
  const from = (b.from ?? '').trim();
  const to = (b.to ?? '').trim();
  const d = lineStarts(t, (l) => l.trimStart().startsWith(from));
  const f = lineStarts(t, (l) => l.trim() === to || l.trimStart().startsWith(to));
  if (d.length === 0) return { ok: false, code: 'ANCHOR_NOT_FOUND', message: `Ligne de début introuvable : « ${from} ».` };
  if (f.length === 0) return { ok: false, code: 'ANCHOR_NOT_FOUND', message: `Ligne de fin introuvable : « ${to} ».` };
  if (d.length > 1 || f.length > 1) return { ok: false, code: 'ANCHOR_AMBIGUOUS', message: `Bornes ambiguës (« ${from} » ×${d.length}, « ${to} » ×${f.length}).` };
  if (d[0] >= f[0]) return { ok: false, code: 'TEXT_TOO_DIVERGENT', message: `La ligne de fin « ${to} » précède la ligne de début « ${from} ».` };
  const zone = t.slice(d[0], f[0]);
  const garde = zoneProtegee(zone, protectedMarkers);
  if (garde) return { ok: false, code: 'TEXT_TOO_DIVERGENT', message: `Remplacement refusé : ${garde}.` };
  const hors = t.slice(0, d[0]) + t.slice(f[0]);
  if (tete && tete !== from && lineStarts(hors, (l) => l.trim() === tete).length) {
    return { ok: false, code: 'ALREADY_PARTIALLY_PRESENT', message: `Le texte actif contient déjà « ${tete.slice(0, 120)} » hors de la zone à remplacer.` };
  }
  return { ok: true, text: `${t.slice(0, d[0])}${b.text}\n\n${t.slice(f[0])}` };
}

// ── Diff par lignes (plus longue sous-suite commune) ────────────────────────

/** Diff ligne à ligne, hunks avec 3 lignes de contexte (pur). */
export function lineDiff(before: string, after: string, context = 3): { added: number; removed: number; hunks: DiffHunk[]; unified: string } {
  const a = lignes(before);
  const b = lignes(after);
  // Préfixe et suffixe communs retirés (corrections localisées : DP minuscule).
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const n = A.length;
  const m = B.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Array<DiffLine & { ai: number; bi: number }> = [];
  for (let k = 0; k < p; k += 1) ops.push({ op: ' ', line: a[k], ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push({ op: ' ', line: A[i], ai: p + i, bi: p + j }); i += 1; j += 1; } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push({ op: '+', line: B[j], ai: p + i, bi: p + j }); j += 1; } else { ops.push({ op: '-', line: A[i], ai: p + i, bi: p + j }); i += 1; }
  }
  for (let k = 0; k < s; k += 1) ops.push({ op: ' ', line: a[a.length - s + k], ai: a.length - s + k, bi: b.length - s + k });
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let derniereModif = -Infinity;
  for (let k = 0; k < ops.length; k += 1) {
    const o = ops[k];
    if (o.op !== ' ') {
      if (!cur || k - derniereModif > 2 * context) {
        const debut = Math.max(0, k - context);
        cur = { oldStart: ops[debut].ai + 1, newStart: ops[debut].bi + 1, lines: ops.slice(debut, k).map(({ op, line }) => ({ op, line })) };
        hunks.push(cur);
      } else {
        for (let x = derniereModif + 1; x < k; x += 1) cur.lines.push({ op: ops[x].op, line: ops[x].line });
      }
      cur.lines.push({ op: o.op, line: o.line });
      derniereModif = k;
    } else if (cur && k - derniereModif <= context) {
      cur.lines.push({ op: ' ', line: o.line });
    }
  }
  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.filter((o) => o.op === '-').length;
  const unified = hunks.map((h) => {
    const vieux = h.lines.filter((l) => l.op !== '+').length;
    const neuf = h.lines.filter((l) => l.op !== '-').length;
    return [`@@ -${h.oldStart},${vieux} +${h.newStart},${neuf} @@`, ...h.lines.map((l) => `${l.op}${l.line}`)].join('\n');
  }).join('\n');
  return { added, removed, hunks, unified };
}

const sameExecution = (a: MasterExecutionConfig, b: MasterExecutionConfig) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applique un plan de correction au texte ACTIF (pur). Les marqueurs
 * protégés sont ceux des AUTRES contrats du registre.
 */
export function applyCorrection(p: {
  text: string; execution: MasterExecutionConfig; steps: readonly CorrectionStep[]; protectedMarkers: readonly string[];
}): CorrectionResult {
  let text = norm(p.text);
  let execution = p.execution;
  const applied: AppliedStep[] = [];
  for (const s of p.steps) {
    if (s.kind === 'execution') {
      applied.push({ kind: 'execution', executionBefore: execution, executionAfter: s.target });
      execution = s.target;
      continue;
    }
    const r = applyBlock(text, s.block, p.protectedMarkers);
    if (!r.ok) {
      if (s.optional && r.code !== 'TEXT_TOO_DIVERGENT') {
        applied.push({ kind: 'block', blockId: s.block.id, action: s.block.action, anchor: s.block.anchor ?? s.block.from, skipped: `${r.message} (bloc documentaire facultatif : ignoré)` });
        continue;
      }
      return refus(r.code, `Bloc officiel « ${s.block.id} » : ${r.message}`, applied);
    }
    applied.push({ kind: 'block', blockId: s.block.id, action: s.block.action, anchor: s.block.anchor ?? s.block.from });
    text = r.text;
  }
  if (text === norm(p.text) && sameExecution(execution, p.execution)) return refus('NOTHING_TO_CHANGE', 'La correction ne change rien au texte ni à la configuration.', applied);
  return { ok: true, text, execution, steps: applied, diff: lineDiff(p.text, text) };
}

// ── Vérification de compatibilité effective ─────────────────────────────────

export interface VerificationIssue { code: string; message: string }

/** Objets JSON d'un bloc (lignes qui commencent par « { », accolades équilibrées). Pur. */
export function jsonExamplesOf(text: string): unknown[] {
  const out: unknown[] = [];
  const ls = text.split('\n');
  for (let k = 0; k < ls.length; k += 1) {
    if (!ls[k].startsWith('{')) continue;
    const reste = ls.slice(k).join('\n');
    let prof = 0; let chaine = false; let echap = false; let fin = -1;
    for (let c = 0; c < reste.length; c += 1) {
      const ch = reste[c];
      if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
      if (ch === '"') chaine = true;
      else if (ch === '{') prof += 1;
      else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    if (fin < 0) continue;
    const brut = reste.slice(0, fin + 1);
    try { out.push(JSON.parse(brut)); } catch { /* fragment documentaire */ }
    k += brut.split('\n').length - 1;
  }
  return out;
}

/**
 * Compatibilité EFFECTIVE d'un texte corrigé (asynchrone : modules du
 * registre IA chargés à la demande, aucune base). Vide : compatible.
 */
export async function verifyCandidate(p: {
  treatment: Treatment; contract: PromptContract; contracts: readonly PromptContract[];
  before: { text: string; execution: MasterExecutionConfig }; after: { text: string; execution: MasterExecutionConfig };
  referenceText: string | null; insertedBlocks: readonly GuideBlock[];
}): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = [];
  const [{ checkMasterPromptContent }, { inspectMasterTemplate }, { AI_OPERATIONS }, { masterOutputSchemaFor }, { validateOutput }] = await Promise.all([
    import('../master-prompts/master-prompt-checks'), import('../prompts/prompt-loader'), import('../registry/operations'),
    import('../gateway/master-output-schemas'), import('../gateway/output-validator'),
  ]);
  // 1. Contrôles bloquants du BO (rendu de chaque branche, emplacements, configuration d'exécution).
  const c = checkMasterPromptContent(p.treatment, p.after.text, p.after.execution);
  for (const i of c.blocking) issues.push({ code: `BO_${i.code}`, message: i.message });
  // 2. Emplacements identiques, branches conservées.
  const av = inspectMasterTemplate(p.before.text);
  const ap = inspectMasterTemplate(p.after.text);
  const plac = (l: readonly string[]) => [...new Set(l)].sort().join('|');
  if (plac(av.placeholders) !== plac(ap.placeholders)) issues.push({ code: 'PLACEHOLDERS_CHANGED', message: `Emplacements {{…}} modifiés : ${plac(av.placeholders)} → ${plac(ap.placeholders)}.` });
  for (const b of av.branches) if (!ap.branches.includes(b)) issues.push({ code: 'BRANCH_LOST', message: `Branche ${b} perdue.` });
  // 3. Aucun autre contrat perdu ; contrat visé satisfait.
  const ctx = (x: { text: string; execution: MasterExecutionConfig }) => ({ text: x.text, execution: x.execution, referenceText: p.referenceText });
  for (const k of p.contracts.filter((x) => x.treatment === p.treatment)) {
    const avant: ContractCheck = await k.check(ctx(p.before));
    const apres: ContractCheck = await k.check(ctx(p.after));
    if (k.id === p.contract.id) {
      if (apres.state !== 'SATISFIED') issues.push({ code: 'CONTRACT_STILL_MISSING', message: `Contrat ${k.id} toujours non satisfait après correction : ${apres.cause}` });
    } else if (avant.state === 'SATISFIED' && apres.state !== 'SATISFIED') {
      issues.push({ code: 'OTHER_CONTRACT_LOST', message: `La correction ferait perdre le contrat ${k.id} : ${apres.cause}` });
    }
  }
  // 4. Exemples JSON des blocs insérés : résolution déterministe de la passerelle (schéma de sortie réel).
  const ops = Object.values(AI_OPERATIONS).filter((o) => o.active && p.contract.operations.includes(o.operationCode));
  for (const b of p.insertedBlocks) {
    for (const ex of jsonExamplesOf(b.text)) {
      if (!ex || typeof ex !== 'object') continue;
      const o = ex as Record<string, unknown>;
      // Fragment (une question, une décision isolée) : documentation, pas une sortie complète.
      if (!('task' in o) && !('schemaVersion' in o) && !('mode' in o)) continue;
      const erreurs: string[] = [];
      let valide = false;
      for (const op of ops) {
        const schema = masterOutputSchemaFor(op.outputSchema);
        if (!schema) continue;
        try {
          validateOutput(JSON.stringify(ex), schema, op.operationCode, 'json', {
            expectedTask: typeof o[op.taskField ?? 'task'] === 'string' ? op.task ?? undefined : undefined,
            taskField: op.taskField ?? 'task', schemaName: op.outputSchema,
          });
          valide = true;
          break;
        } catch (e) {
          erreurs.push(`${op.operationCode} : ${(e as Error).message.slice(0, 160)}`);
        }
      }
      if (!valide && ops.length) issues.push({ code: 'EXAMPLE_REJECTED', message: `Exemple JSON du bloc ${b.id} refusé par le schéma de sortie réel (${erreurs.join(' ; ').slice(0, 400)}).` });
    }
  }
  return issues;
}
