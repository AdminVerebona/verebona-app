/**
 * Classement FONCTIONNEL d'un échec d'analyse — lot 34C.
 *
 * Lit le motif TECHNIQUE conservé sur le document (`analysis_fail_reason`,
 * jamais transmis à l'application) et le traduit en un code du référentiel
 * fermé (`@/lib/ai/processing-status`). Seuls les problèmes du FICHIER,
 * sur lesquels l'utilisateur peut agir (fichier protégé, endommagé, vide,
 * format non exploitable, illisible), donnent un message ciblé ; tout le
 * reste (sortie de modèle non conforme, panne fournisseur, délai…) est un
 * échec générique `ANALYSIS_FAILED_FINAL`.
 *
 * ⚠️ Une sortie de modèle invalide (`Sortie non conforme au schéma`,
 * `INVALID_OUTPUT`, chemins `document.*`) n'est JAMAIS un problème de
 * fichier : elle est écartée avant toute autre règle, pour qu'un nom de
 * champ comme `document.title` ne soit pas pris pour « document vide ».
 *
 * Pur, testé.
 */
import type { UserMessageCode } from '@/lib/ai/processing-status';

const MODEL_OUTPUT = /sortie non conforme|invalid_output|invalid input|schema|schéma|json/i;

const RULES: Array<[UserMessageCode, RegExp]> = [
  ['FILE_PASSWORD_PROTECTED', /password|mot de passe|encrypted|chiffr[ée]|protégé par|protected (pdf|document|file)/i],
  ['FILE_CORRUPTED', /corrupt|damaged|endommag|malformed (pdf|file)|invalid pdf|pdf (is )?invalid|cannot be (opened|parsed)|unable to process (the )?(input )?file|failed to (read|parse) (the )?(pdf|file)/i],
  ['FILE_UNSUPPORTED', /unsupported (mime|file|format|media)|mime[ -]?type[^.]*not supported|format non (pris en charge|supporté)/i],
  ['FILE_EMPTY', /(document|file|pdf|fichier) (is )?empty|empty (file|document|pdf)|has no pages|no pages|fichier vide|aucune page|0 bytes/i],
  ['FILE_UNREADABLE', /objet s3 exploitable|nosuchkey|no such key|unreadable|illisible/i],
];

export function classifyUserFailure(technicalReason: string | null | undefined): UserMessageCode {
  const t = (technicalReason ?? '').trim();
  if (!t || MODEL_OUTPUT.test(t)) return 'ANALYSIS_FAILED_FINAL';
  for (const [code, re] of RULES) if (re.test(t)) return code;
  return 'ANALYSIS_FAILED_FINAL';
}
