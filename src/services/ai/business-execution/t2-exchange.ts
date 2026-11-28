/**
 * Carte #880 (E03, R03) — export unitaire d'une exécution T2 : la DEMANDE,
 * la RÉPONSE et la TRACE de cascade disponibles.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Constat : l'export « avec échanges » d'une demande de l'assistant ne
 * restituait ni la question, ni la réponse, ni l'intention, ni la stratégie
 * tentée, ni le motif d'abandon — un « classic_search, 0 appel IA » ne
 * pouvait pas être rapproché d'un parcours.
 *
 * Désormais, pour une exécution T2, l'export porte un bloc `assistant` :
 *   · `run`        : intention, mode, état final, statut technique, compteurs ;
 *   · `cascade`    : niveau qui a répondu, stratégie, décision de suffisance,
 *                    diagnostic, motifs d'escalade, tentatives, appels IA,
 *                    accès IA, lecture métier (`businessReading`, carte #880) ;
 *   · `outcome`    : issue FONCTIONNELLE, distincte du succès technique ;
 *   · `question` / `answer` : texte INCLUS seulement pour un administrateur
 *                    habilité (`?contenus=1`, même accès et même journal que
 *                    les échanges IA) ; sinon masqué (longueur + SHA-256) ;
 *   · `absent`     : ce qui manque, dit explicitement (aucun appel IA,
 *                    message purgé, trace non enregistrée…).
 * Lecture seule, dans l'instantané de l'export ; aucun secret (masquage des
 * secrets et e-mails sur la trace).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { maskForExport } from '@/services/admin/diagnostics-export/model';

type Q = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Champs de la trace de cascade restitués (codes et compteurs ; jamais de contenu libre). */
const CASCADE_KEYS = [
  'intent', 'strategy', 'answeredBy', 'sufficiency', 'diagnostic', 'escalationReasons', 'attempts', 'aiCalls', 'model',
  'fallbackUsed', 'fallbackReason', 'access', 'businessReading', 'sourceCount', 'latencyMs', 'cacheHit', 'levelsReached', 'notices',
] as const;

export type T2Outcome =
  | 'ANSWERED' | 'LOCKED' | 'CLARIFICATION' | 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'TARGET_UNAVAILABLE' | 'FIELD_NOT_SET'
  | 'SEARCH_NO_RESULT' | 'UNDERSTANDING_FAILED' | 'READ_ERROR' | 'NO_ASSET' | 'TECHNICAL_ERROR' | 'UNKNOWN';

/** Issue FONCTIONNELLE (pure, testée) : la lecture métier prime, puis le diagnostic, puis l'état technique. */
export function functionalOutcome(run: { status: string | null; errorCode: string | null } | null, cascade: Record<string, unknown> | null): T2Outcome {
  const br = cascade?.businessReading as { outcome?: string } | undefined;
  if (br?.outcome) return br.outcome as T2Outcome;
  const d = str(cascade?.diagnostic);
  if (d === 'TECHNICAL_READ_FAILURE') return 'READ_ERROR';
  if (d) return d as T2Outcome;
  if (run?.status === 'error' || run?.errorCode) return 'TECHNICAL_ERROR';
  if (cascade?.answeredBy) return 'ANSWERED';
  return 'UNKNOWN';
}

function message(row: Record<string, unknown> | undefined, sensitive: boolean, absentMotif: string): Record<string, unknown> {
  if (!row) return { $etat: 'absent', motif: absentMotif };
  const base = { messageId: num(row.id), statut: str(row.status), longueur: num(row.len), sha256: str(row.sha), at: row.created_at ? new Date(String(row.created_at)).toISOString() : null };
  return sensitive ? { $etat: 'inclus', ...base, texte: str(row.content) } : { $etat: 'masqué', ...base };
}

/** Bloc `assistant` d'une exécution T2 (`requestId`) — `null` si aucune ligne de demande. */
export async function readT2Exchange(q: Q, requestId: string, sensitive: boolean): Promise<Record<string, unknown>> {
  const [r] = await q(`SELECT intent, mode, machine_final_state, status, error_code, source_count, candidate_count, latency_ms, cache_hit,
                              retrieval_methods_json
                         FROM verebona_request_runs WHERE request_id = $1 ORDER BY id DESC LIMIT 1`, [requestId]);
  const msgs = await q(`SELECT id, role, status, mode, intent, created_at,
                               length(coalesce(content, '')) AS len, encode(sha256(convert_to(coalesce(content, ''), 'UTF8')), 'hex') AS sha
                               ${sensitive ? ', content' : ''}
                          FROM verebona_messages WHERE request_id = $1 ORDER BY id`, [requestId]);
  const raw = r?.retrieval_methods_json;
  const json = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })() : (raw as Record<string, unknown> | null) ?? null;
  const cascade = json && typeof json === 'object'
    ? Object.fromEntries(CASCADE_KEYS.filter((k) => json[k] !== undefined).map((k) => [k, json[k]])) as Record<string, unknown>
    : null;
  const run = r ? {
    intent: str(r.intent), mode: str(r.mode), finalState: str(r.machine_final_state), status: str(r.status), errorCode: str(r.error_code),
    sourceCount: num(r.source_count), candidateCount: num(r.candidate_count), latencyMs: num(r.latency_ms), cacheHit: r.cache_hit == null ? null : Boolean(r.cache_hit),
  } : null;
  const user = msgs.find((m) => m.role === 'user');
  const assistant = [...msgs].reverse().find((m) => m.role === 'assistant');
  const absent: string[] = [];
  if (!run) absent.push('Ligne de demande absente (verebona_request_runs) : intention, mode et état final inconnus.');
  if (run && !cascade) absent.push('Trace de cascade non enregistrée pour cette demande (retrieval_methods_json vide).');
  const aiCalls = num(cascade?.aiCalls);
  if (aiCalls === 0) absent.push('Aucun appel IA : réponse produite sans modèle (aiCalls = 0) — aucun échange modèle à restituer.');
  if (!cascade?.businessReading) absent.push('Aucune lecture métier déterministe tracée (businessReading) pour cette demande.');
  if (!user) absent.push('Question non conservée (message utilisateur purgé à l’expiration du fil, ou demande sans message).');
  if (!assistant) absent.push('Réponse non conservée (message assistant purgé à l’expiration du fil, ou demande interrompue).');
  return {
    requestId,
    run,
    cascade: cascade ? maskForExport(cascade) : null,
    outcome: functionalOutcome(run, cascade),
    technicalStatus: run?.status ?? null,
    question: message(user, sensitive, 'non conservée'),
    answer: message(assistant, sensitive, 'non conservée'),
    answerMode: str(assistant?.mode),
    absent,
  };
}
