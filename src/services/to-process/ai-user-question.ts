/**
 * Lot 113S (Trello #716, post-MEP) — QUESTION D'ARBITRAGE FORMULÉE PAR LE
 * TRAITEMENT IA, CONTRÔLÉE PAR LE CODE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI FORMULE, QUI CONTRÔLE
 *
 * Quand un traitement IA EXISTANT (T3, T4) décide qu'un arbitrage métier est
 * nécessaire, la MÊME sortie structurée peut porter une `userQuestion` :
 * question courte, naturelle, fondée sur les éléments qu'il a examinés. Aucun
 * second appel « reformulation », aucun passage IA à l'ouverture de l'écran.
 *
 * Le code ne réécrit pas cette question et ne prétend pas en revalider le
 * sens. Il CONTRÔLE seulement (`validateAiUserQuestion`, pure) :
 *   · forme : texte, longueur bornée, une question (« ? ») ;
 *   · langue : français ;
 *   · vocabulaire : ni jargon technique (`card-labels.ts`), ni « Opération »
 *     (on dit « événement de référence »), ni nom de traitement ;
 *   · sécurité : ni e-mail, ni téléphone, ni IBAN, ni lien, ni longue suite
 *     de chiffres, ni valeur masquée (« [ … ] ») ;
 *   · monde fermé : tout libellé CITÉ (« … ») appartient au contexte de la
 *     carte (biens candidats, documents examinés, choix proposés) ; aucun nom
 *     d'un autre objet du compte hors de ce contexte.
 * Les ACTIONS restent celles du serveur (propositions de la carte) : le texte
 * libre n'est jamais exécutable.
 *
 * REPLI (`chooseCardQuestion`) : sortie sans question (prompt sans le bloc du
 * guide, ancienne version) ou question refusée → formulation déterministe du
 * producteur, qui décrit honnêtement ce que le traitement a décidé, avec sa
 * provenance (`question_source`, migration 1540 : origine, motif du repli,
 * version de prompt, trace). Quand le prompt ACTIF porte le marqueur du
 * contrat (blocs 24 / 25 du guide du PO), une question absente ou refusée est
 * en plus signalée en Supervision : la carte n'est jamais présentée comme
 * formulée par l'IA.
 *
 * Le code ne modifie jamais un prompt. Activation : le PO colle les blocs du
 * guide docs/exploitation/prompts-a-appliquer-par-le-po.md (étapes 24, 25).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { technicalLabelIssues } from './card-labels';

/** Marqueur du contrat de question dans le prompt maître T3 (branches LINK_AMBIGUITY, OPERATION_MATCH). */
export const T3_USER_QUESTION_CONTRACT = 't3-user-question-v1';
/** Marqueur du contrat de question dans le prompt maître T4 (branche AGENDA_REPRESENTATION). */
export const T4_USER_QUESTION_CONTRACT = 't4-user-question-v1';

/** Bornes d'une question affichée (caractères, après normalisation des espaces). */
export const AI_QUESTION_MIN_LENGTH = 15;
export const AI_QUESTION_MAX_LENGTH = 240;

export type QuestionRejection =
  | 'ABSENT' | 'NOT_TEXT' | 'TOO_SHORT' | 'TOO_LONG' | 'NOT_A_QUESTION' | 'NOT_FRENCH'
  | 'TECHNICAL_WORDING' | 'FORBIDDEN_TERM' | 'SENSITIVE_DATA' | 'UNKNOWN_REFERENCE' | 'FOREIGN_LABEL'
  | 'SUBJECT_MISMATCH';

export interface QuestionCheckContext {
  /** Libellés que la question peut citer : biens candidats, documents ou événements examinés, choix proposés. */
  allowedLabels: ReadonlyArray<string | null | undefined>;
  /** Libellés d'autres objets du compte, hors du contexte de la carte : jamais cités. */
  foreignLabels?: ReadonlyArray<string | null | undefined>;
}

export type QuestionCheck = { ok: true; question: string } | { ok: false; code: QuestionRejection };

/** Pliage pour comparer des libellés (casse, accents, apostrophes, espaces, ponctuation finale). Pure. */
export function foldLabel(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, '\'').toLowerCase()
    .replace(/\s+/g, ' ').trim().replace(/[\s.,;:!?…]+$/u, '').trim();
}

const QUOTES = /«\s*([^»]{1,200}?)\s*»|“([^”]{1,200})”|"([^"]{1,200})"/g;

/** Mots-outils : la question doit être rédigée en français. */
const FR = /\b(?:le|la|les|l|ce|cet|cette|ces|de|du|des|d|un|une|au|aux|à|est|sont|il|elle|faut|quel|quelle|quels|quelles|lequel|laquelle|s|agit|concerne|concernent|doit|votre|vos|ou|et|pour|avec|sur|dans|que|qui|même|bien|document|garder|rattacher)\b/giu;
const EN = /\b(?:the|is|are|this|that|which|does|do|should|belong|belongs|to|of|with|same|keep|attach|asset|event)\b/gi;

const SENSITIVE: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/u,
  /https?:\/\/|\bwww\./i,
  /(?:\+33|\b0)\s?[1-9](?:[\s.-]?\d{2}){4}\b/,
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,}/i,
  /\d(?:[\s.-]?\d){9,}/,
  /\[[^\]]{0,120}\]/,
];

const FORBIDDEN: readonly RegExp[] = [
  // Règle permanente : jamais « Opération » à l'écran — « événement de référence ».
  /\bop[ée]rations?\b/iu,
  /\b(?:prompt|LLM|GPT|json|null|undefined)\b/i,
  /\bIA\b/,
];

/**
 * Contrôle d'une question proposée par un traitement IA (pure). Rend la
 * question NORMALISÉE (espaces) — exactement le texte qui sera enregistré et
 * affiché — ou le motif du refus.
 */
export function validateAiUserQuestion(raw: unknown, ctx: QuestionCheckContext): QuestionCheck {
  if (raw === undefined || raw === null) return { ok: false, code: 'ABSENT' };
  if (typeof raw !== 'string') return { ok: false, code: 'NOT_TEXT' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, code: 'NOT_TEXT' };
  const question = raw.replace(/\s+/g, ' ').trim();
  if (!question) return { ok: false, code: 'ABSENT' };
  if (question.length < AI_QUESTION_MIN_LENGTH) return { ok: false, code: 'TOO_SHORT' };
  if (question.length > AI_QUESTION_MAX_LENGTH) return { ok: false, code: 'TOO_LONG' };
  if (!/\?$/.test(question)) return { ok: false, code: 'NOT_A_QUESTION' };

  const cites: string[] = [];
  const horsCitations = question.replace(QUOTES, (_m, a?: string, b?: string, c?: string) => { cites.push((a ?? b ?? c ?? '').trim()); return ' « » '; });
  if (SENSITIVE.some((re) => re.test(question))) return { ok: false, code: 'SENSITIVE_DATA' };
  if (FORBIDDEN.some((re) => re.test(horsCitations))) return { ok: false, code: 'FORBIDDEN_TERM' };
  // Jargon : motifs sûrs sur tout le texte ; motifs propres au texte système hors des libellés cités (« Appartement T3 »).
  if (technicalLabelIssues(question, { userContent: true }).length || technicalLabelIssues(horsCitations).length) {
    return { ok: false, code: 'TECHNICAL_WORDING' };
  }
  const fr = new Set((horsCitations.match(FR) ?? []).map((w) => w.toLowerCase())).size;
  const en = (horsCitations.match(EN) ?? []).length;
  if (fr < 2 || (en >= 2 && en >= fr)) return { ok: false, code: 'NOT_FRENCH' };

  const permis = ctx.allowedLabels.filter((l): l is string => typeof l === 'string' && !!l.trim()).map(foldLabel);
  for (const c of cites) {
    const q = foldLabel(c.replace(/…$/u, ''));
    if (!q) continue;
    const tronque = /…$/u.test(c.trim());
    const connu = permis.some((p) => p === q || ((tronque || q.length >= 8) && p.startsWith(q)));
    if (!connu) return { ok: false, code: 'UNKNOWN_REFERENCE' };
  }

  // Autres objets du compte : seuls les libellés distinctifs (plusieurs mots ou un chiffre) sont recherchés
  // hors citation — un nom commun (« Maison ») peut figurer légitimement dans une phrase.
  const texte = foldLabel(horsCitations);
  for (const f of ctx.foreignLabels ?? []) {
    if (typeof f !== 'string') continue;
    const n = foldLabel(f);
    if (n.length < 4 || !(/\s/.test(n) || /\d/.test(n))) continue;
    if (permis.some((p) => p.includes(n))) continue;
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u').test(texte)) {
      return { ok: false, code: 'FOREIGN_LABEL' };
    }
  }
  return { ok: true, question };
}

// ── Provenance (`to_process_actions.question_source`) ──────────────────────

export interface QuestionSource {
  /** AI : question du traitement, contrôlée ; CODE : formulation déterministe du producteur. */
  origin: 'AI' | 'CODE';
  rule: string;
  treatment: 'T3' | 'T4' | null;
  operation: string | null;
  /** Marqueur du contrat de question ; `contractActive` : présent dans la version EFFECTIVE du prompt. */
  contract: string | null;
  contractActive: boolean;
  promptVersion: string | null;
  traceId: string | null;
  /** CODE seulement : pourquoi la question du traitement n'est pas affichée. */
  fallback: 'AI_QUESTION_ABSENT' | 'AI_QUESTION_REJECTED' | 'AI_NOT_CALLED' | null;
  rejection: QuestionRejection | null;
  at: string;
}

export interface AiQuestionInput {
  rule: string;
  treatment: 'T3' | 'T4';
  operation: string;
  contract: string;
  /** Question brute proposée par le modèle (absente : ancienne version du prompt). */
  raw: unknown;
  /** Le modèle a-t-il été appelé pour CETTE décision (faux : décision mémorisée sans question, IA indisponible) ? */
  aiCalled: boolean;
  contractActive: boolean;
  promptVersion?: string | null;
  traceId?: string | null;
  check: QuestionCheckContext;
  /** Formulation déterministe honnête du producteur (repli). `undefined` : question du catalogue. */
  fallbackQuestion?: string;
  now?: Date;
}

export interface ChosenQuestion {
  /** `undefined` : question du catalogue (repli de la règle). */
  question: string | undefined;
  source: QuestionSource;
  /** Contrat actif mais question absente / refusée : à signaler en Supervision. */
  anomaly: QuestionRejection | null;
}

/** Choix de la question d'une carte (pure) : celle du traitement si elle passe le contrôle, sinon le repli tracé. */
export function chooseCardQuestion(i: AiQuestionInput): ChosenQuestion {
  const base = {
    rule: i.rule, treatment: i.treatment, operation: i.operation, contract: i.contract, contractActive: i.contractActive,
    promptVersion: i.promptVersion ?? null, traceId: i.traceId ?? null, at: (i.now ?? new Date()).toISOString(),
  };
  const v = validateAiUserQuestion(i.raw, i.check);
  if (v.ok) return { question: v.question, source: { ...base, origin: 'AI', fallback: null, rejection: null }, anomaly: null };
  const fallback: QuestionSource['fallback'] = !i.aiCalled && v.code === 'ABSENT' ? 'AI_NOT_CALLED' : v.code === 'ABSENT' ? 'AI_QUESTION_ABSENT' : 'AI_QUESTION_REJECTED';
  return {
    question: i.fallbackQuestion,
    source: { ...base, origin: 'CODE', fallback, rejection: v.code === 'ABSENT' ? null : v.code },
    anomaly: i.contractActive && i.aiCalled ? v.code : null,
  };
}

/** Provenance lue en base (tolérante : ligne antérieure au lot 113S → null). Pure. */
export function readQuestionSource(v: unknown): QuestionSource | null {
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  if (!o || typeof o !== 'object') return null;
  const s = o as Partial<QuestionSource>;
  return s.origin === 'AI' || s.origin === 'CODE' ? (s as QuestionSource) : null;
}

/** La question enregistrée vient-elle du traitement IA (contrôlée) ? Pure. */
export function isAiQuestion(v: unknown): boolean {
  return readQuestionSource(v)?.origin === 'AI';
}

// ── Contrat actif (version EFFECTIVE du prompt, mémorisée une minute) ───────

const memo = new Map<string, { at: number; active: boolean }>();
const MEMO_MS = 60_000;

/** Le texte d'un prompt porte-t-il le marqueur ? (pure) */
export function promptCarriesQuestionContract(text: string | null | undefined, marker: string): boolean {
  return typeof text === 'string' && text.includes(marker);
}

/**
 * La version EFFECTIVE du prompt de l'opération porte-t-elle le marqueur du
 * contrat de question ? Même résolution que la passerelle (version BO active,
 * sinon fichier du dépôt). Ne lève jamais (illisible : faux).
 */
export async function questionContractActive(operation: string, marker: string): Promise<boolean> {
  const cle = `${operation}|${marker}`;
  const m = memo.get(cle);
  if (m && Date.now() - m.at < MEMO_MS) return m.active;
  let active = false;
  try {
    const { effectivePromptOf } = await import('@/services/ai/master-prompts/effective-prompt');
    active = promptCarriesQuestionContract((await effectivePromptOf(operation)).text, marker);
  } catch (e) {
    console.error(`[to-process] version du prompt de ${operation} illisible (contrat de question) :`, (e as Error).message);
  }
  memo.set(cle, { at: Date.now(), active });
  return active;
}

/** Tests seulement. */
export function __resetQuestionContractMemo(): void { memo.clear(); }

/**
 * Supervision : contrat de question actif, mais question absente ou refusée
 * (la carte garde la formulation déterministe tracée). Une anomalie par
 * compte, règle et motif (empreinte stable, dédoublonnée). Ne lève jamais.
 */
export async function reportQuestionAnomaly(p: { accountId: number; rule: string; code: QuestionRejection; operation: string; ref: string | number }): Promise<void> {
  try {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'ai', fingerprint: buildFingerprint('ai', 'to-process-ai-question', `${p.rule}:${p.code}`, p.accountId), accountId: p.accountId,
      title: `À traiter — question de l’IA non retenue (${p.rule}, ${p.code}) : formulation de repli affichée`,
      detail: {
        code: `AI_USER_QUESTION_${p.code}`, rule: p.rule, operation: p.operation, ref: String(p.ref).slice(0, 80),
        effect: 'carte conservée avec la formulation déterministe tracée (question_source.origin = CODE) ; nouvelle question au passage suivant du traitement',
      },
    });
  } catch (e) {
    console.error(`[to-process] supervision non alimentée (question ${p.rule}) :`, (e as Error).message);
  }
}

/**
 * Choix de la question d'une carte + signalement Supervision si le contrat
 * est actif et la question absente ou refusée. Ne lève jamais.
 */
export async function resolveAiCardQuestion(accountId: number, i: AiQuestionInput, ref: string | number): Promise<ChosenQuestion> {
  const c = chooseCardQuestion(i);
  if (c.anomaly) await reportQuestionAnomaly({ accountId, rule: i.rule, code: c.anomaly, operation: i.operation, ref });
  if (c.source.origin === 'CODE' && c.source.rejection) {
    console.warn(`[to-process] question de l’IA refusée (${i.rule}, ${ref}) : ${c.source.rejection} — formulation de repli.`);
  }
  return c;
}
