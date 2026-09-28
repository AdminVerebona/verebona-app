/**
 * Schémas d'entrée des routes de l'assistant — CDC §27 (« valident les
 * entrées avec un schéma »), §27.1 à §27.10.
 *
 * Le `message` de chaque contrainte est un code stable (EMPTY_MESSAGE…) :
 * `parseWith` le renvoie comme motif de `VALIDATION_FAILED`, pour que les
 * clients existants gardent un diagnostic précis.
 *
 * Les clés inconnues sont ignorées (le client peut évoluer), mais aucune
 * n'atteint le traitement : seules les valeurs typées ci-dessous passent.
 */
import { z } from 'zod';

/** Entier positif transmis en chaîne ou en nombre, sinon `null`. */
function entierPositif(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Identifiant entier positif ; le code donné est le motif en cas de refus. */
const idPositif = (code: string) => z.unknown().transform((v, ctx) => {
  const n = entierPositif(v);
  if (n === null) {
    ctx.addIssue({ code: 'custom', message: code });
    return z.NEVER;
  }
  return n;
});

/** Identifiant de fil facultatif : absent, nul ou vide = fil le plus récent. */
const conversationIdFacultatif = z.unknown().optional().transform((v, ctx) => {
  if (v === undefined || v === null || v === '') return null;
  const n = entierPositif(v);
  if (n === null) {
    ctx.addIssue({ code: 'custom', message: 'CONVERSATION_NOT_FOUND' });
    return z.NEVER;
  }
  return n;
});

const clientRequestId = z.string({ error: 'MISSING_CLIENT_REQUEST_ID' })
  .min(1, 'MISSING_CLIENT_REQUEST_ID')
  .max(100, 'INVALID_CLIENT_REQUEST_ID')
  .regex(/^[A-Za-z0-9._:-]+$/, 'INVALID_CLIENT_REQUEST_ID');

/** POST /api/verebona/messages — §27.1. */
export const PostMessageSchema = z.object({
  message: z.string({ error: 'EMPTY_MESSAGE' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, 'EMPTY_MESSAGE')
    .refine((s) => s.length <= 2000, 'MESSAGE_TOO_LONG'),
  clientRequestId,
  // Contexte de page : forme libre ici, filtré clé par clé ensuite
  // (`sanitizePageContext`).
  pageContext: z.record(z.string(), z.unknown()).nullable().optional(),
  conversationId: conversationIdFacultatif,
  locale: z.string().max(10).optional(),
  // Contrôlé à part (`assertNoClientAccountOverride`) : présent, il doit
  // correspondre à la session.
  accountId: z.unknown().optional(),
});

/** POST /api/verebona/clarifications/{id}/answer — §27.3. */
export const ClarificationParamsSchema = z.object({
  clarificationId: z.string().min(1, 'MISSING_CLARIFICATION').max(100, 'MISSING_CLARIFICATION'),
});
export const ClarificationAnswerSchema = z.object({
  choiceId: z.string({ error: 'MISSING_CHOICE' })
    .min(1, 'MISSING_CHOICE').max(100, 'MISSING_CHOICE'),
  clientRequestId: clientRequestId.optional(),
  conversationId: conversationIdFacultatif,
});

/** GET / DELETE /api/verebona/conversation — §27.6, §27.7. */
export const ConversationQuerySchema = z.object({
  // Contrôlé par la route : un identifiant invalide est traité comme un fil
  // inexistant (404), sans rien révéler.
  conversationId: z.string().max(20).optional(),
  // §27.6 : `limit` 50 au plus ; `cursor` (curseur rendu par la page
  // précédente) et `before` (identifiant de message) sont synonymes.
  limit: z.string().regex(/^\d{1,3}$/, 'INVALID_LIMIT').transform(Number)
    .refine((n) => n >= 1 && n <= 50, 'INVALID_LIMIT').optional(),
  cursor: idPositif('INVALID_CURSOR').optional(),
  before: idPositif('INVALID_CURSOR').optional(),
});

/** Routes `messages/{messageId}/…` — §27.8, §27.9, §27.10. */
export const MessageParamsSchema = z.object({
  messageId: idPositif('INVALID_MESSAGE_ID'),
});

/** GET …/sources — §27.8 (pagination au-delà de cinq sources). */
export const SourcesQuerySchema = z.object({
  limit: z.string().regex(/^\d{1,3}$/, 'INVALID_LIMIT').transform(Number)
    .refine((n) => n >= 1 && n <= 20, 'INVALID_LIMIT').optional(),
  offset: z.string().regex(/^\d{1,6}$/, 'INVALID_OFFSET').transform(Number).optional(),
});

/** POST …/feedback — §27.10. */
export const FeedbackSchema = z.object({
  value: z.enum(['helpful', 'not_helpful'], { error: 'INVALID_VALUE' }),
  reason: z.enum(['incorrect_answer', 'missing_information', 'wrong_source', 'wrong_action', 'too_long', 'other'], { error: 'INVALID_REASON' }).nullable().optional(),
});

/** GET / DELETE /api/verebona/requests/{requestId} — §27.4, §27.5. */
export const RequestParamsSchema = z.object({
  requestId: z.string().min(1, 'INVALID_REQUEST_ID').max(100, 'INVALID_REQUEST_ID')
    .regex(/^[A-Za-z0-9._:-]+$/, 'INVALID_REQUEST_ID'),
});

/** POST /api/verebona/commands/{planId}/(confirm|cancel) : aucun paramètre hors l'identifiant. */
export const PlanParamsSchema = z.object({
  planId: z.string().min(1, 'PLAN_NOT_FOUND').max(64, 'PLAN_NOT_FOUND').regex(/^[A-Za-z0-9_-]+$/, 'PLAN_NOT_FOUND'),
});

/** POST /api/verebona/conversations : corps vide ou ignoré. */
export const CreateConversationSchema = z.object({}).passthrough();

/**
 * GET /api/verebona/suggestions — §8.1, §27.
 * `route` : chemin interne de la page (jamais une URL). Au-delà de 500
 * caractères : VALIDATION_FAILED ; un chemin hors du motif interne retombe
 * sur « / » (suggestions génériques), comme avant — le panneau ne doit pas
 * perdre ses suggestions pour une page au chemin inattendu.
 */
export const SuggestionsQuerySchema = z.object({
  route: z.string().max(500, 'INVALID_ROUTE').optional()
    .transform((r) => (r && /^\/[\w\-/]{0,200}$/.test(r) ? r : '/')),
});
