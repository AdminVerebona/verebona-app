/**
 * Carte #849 (A2, complément) — GARDE CENTRALE « bien TRANSMIS = consultation
 * seule » pour TOUTES les écritures et tous les rattachements, directs ou
 * indirects : routes (UI / API), façades d'écriture partagées (Opérations,
 * Agenda), traitements automatiques (T1, T3, T4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Une cible est EN LECTURE SEULE quand :
 *   · asset      le bien est TRANSMIS (écrire dessus OU y rattacher quoi que
 *                ce soit est refusé) ;
 *   · room / equipment  son bien porteur est TRANSMIS ;
 *   · document / operation / agenda  elle vise au moins un bien TRANSMIS et
 *                AUCUN bien en service (un élément partagé avec un bien actif
 *                reste modifiable pour celui-ci).
 * Seules exceptions (par conception) : « Remettre en service »,
 * « Supprimer définitivement », lectures et exports.
 *
 * Routes : `refuserSiRequeteSurBienTransmis(request, context, spec)` en tête
 * de chaque handler d'écriture (test d'inventaire
 * `__tests__/c849b-inventaire-ecritures.test.ts`). Traitements automatiques :
 * `estEnLectureSeule(...)` → abstention journalisée, jamais d'erreur bloquante.
 *
 * Module séparé de `asset-quota-guard` (que de nombreux scénarios simulent).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { ASSET_READ_ONLY_MESSAGE } from '@/lib/asset-status';

export type ReadOnlyTargetKind =
  | 'asset' | 'room' | 'equipment' | 'document' | 'documentPublicId' | 'operation' | 'agenda'
  | 'agendaConflict' | 'aiFieldUpdate' | 'moveRequest' | 'toProcessCard' | 'deadline';

export interface ReadOnlyTarget { kind: ReadOnlyTargetKind; id: number | string }

/** Biens visés (sous-requête SQL renvoyant des `asset_id`) pour une cible ; `$1` = id, `$2` = compte. */
const BIENS: Record<Exclude<ReadOnlyTargetKind, 'asset' | 'room' | 'equipment' | 'toProcessCard'>, string> = {
  document: `
    SELECT f.asset_id FROM asset_files f WHERE f.id = $1::int AND f.account_id = $2 AND f.asset_id IS NOT NULL
    UNION SELECT f.linked_asset_id FROM asset_files f WHERE f.id = $1::int AND f.account_id = $2 AND f.linked_asset_id IS NOT NULL
    UNION SELECT s.asset_id FROM asset_files f JOIN substructures s ON s.id = f.substructure_id WHERE f.id = $1::int AND f.account_id = $2
    UNION SELECT e.asset_id FROM asset_files f JOIN equipments e ON e.id = f.equipment_id WHERE f.id = $1::int AND f.account_id = $2
    UNION SELECT COALESCE(l.asset_id, e.asset_id, s.asset_id) FROM document_asset_links l
            LEFT JOIN equipments e ON e.id = l.equipment_id LEFT JOIN substructures s ON s.id = l.substructure_id
      WHERE l.file_id = $1::int AND l.account_id = $2 AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY')`,
  documentPublicId: `
    SELECT x.asset_id FROM (
      SELECT f.asset_id FROM asset_files f WHERE f.public_id::text = $1::text AND f.account_id = $2 AND f.asset_id IS NOT NULL
      UNION SELECT f.linked_asset_id FROM asset_files f WHERE f.public_id::text = $1::text AND f.account_id = $2 AND f.linked_asset_id IS NOT NULL
      UNION SELECT COALESCE(l.asset_id, e.asset_id, s.asset_id) FROM document_asset_links l JOIN asset_files f ON f.id = l.file_id
              LEFT JOIN equipments e ON e.id = l.equipment_id LEFT JOIN substructures s ON s.id = l.substructure_id
        WHERE f.public_id::text = $1::text AND l.account_id = $2 AND l.status = 'ACTIVE' AND l.link_role IN ('PRIMARY', 'SECONDARY')) x(asset_id)`,
  operation: `
    SELECT l.asset_id FROM business_operation_asset_links l WHERE l.operation_id = $1::bigint AND l.account_id = $2 AND l.active
    UNION SELECT l.asset_id FROM business_operation_equipment_links l WHERE l.operation_id = $1::bigint AND l.account_id = $2 AND l.active
    UNION SELECT l.asset_id FROM business_operation_room_links l WHERE l.operation_id = $1::bigint AND l.account_id = $2 AND l.active`,
  agenda: `
    SELECT l.asset_id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.id = $1::int AND i.account_id = $2
    UNION SELECT e.asset_id FROM agenda_equipment_links l JOIN equipments e ON e.id = l.equipment_id JOIN agenda_items i ON i.id = l.agenda_item_id
      WHERE i.id = $1::int AND i.account_id = $2
    UNION SELECT s.asset_id FROM agenda_room_links l JOIN substructures s ON s.id = l.substructure_id JOIN agenda_items i ON i.id = l.agenda_item_id
      WHERE i.id = $1::int AND i.account_id = $2`,
  agendaConflict: `
    SELECT l.asset_id FROM agenda_data_conflicts c JOIN agenda_asset_links l ON l.agenda_item_id = c.agenda_item_id
     WHERE c.id = $1::int AND c.account_id = $2`,
  aiFieldUpdate: `SELECT u.asset_id FROM ai_field_updates u JOIN assets a ON a.id = u.asset_id WHERE u.id = $1::int AND a.account_id = $2`,
  moveRequest: `SELECT r.asset_id FROM asset_move_requests r JOIN assets a ON a.id = r.asset_id WHERE r.id = $1::int AND a.account_id = $2`,
  deadline: `
    SELECT d.asset_id FROM deadlines d WHERE d.id = $1::int AND d.account_id = $2 AND d.asset_id IS NOT NULL
    UNION SELECT d.linked_asset_id FROM deadlines d WHERE d.id = $1::int AND d.account_id = $2 AND d.linked_asset_id IS NOT NULL`,
};

/** Bien porteur DIRECT (écrire dessus ou y rattacher : refusé dès qu'il est transmis). */
const PORTEUR: Record<'asset' | 'room' | 'equipment', string> = {
  asset: `SELECT a.id AS asset_id FROM assets a WHERE a.id = $1::int AND a.account_id = $2`,
  room: `SELECT s.asset_id FROM substructures s JOIN assets a ON a.id = s.asset_id WHERE s.id = $1::int AND a.account_id = $2`,
  equipment: `SELECT e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE e.id = $1::int AND a.account_id = $2`,
};

type Runner = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
const runnerParDefaut = async (): Promise<Runner> => (await import('@/db')).pgClient as unknown as Runner;

/** Carte « À traiter » → cible réelle (bien, document, Agenda, équipement). */
async function cibleDeCarte(r: Runner, publicId: string, accountId: number): Promise<ReadOnlyTarget | null> {
  const [c] = (await r.unsafe(
    `SELECT target_type, target_id FROM to_process_actions WHERE public_id::text = $1::text AND account_id = $2 LIMIT 1`,
    [publicId, accountId] as never[],
  )) as Array<{ target_type: string; target_id: number }>;
  if (!c) return null;
  const t = String(c.target_type).toUpperCase();
  const kind: ReadOnlyTargetKind | null = t === 'ASSET' ? 'asset' : t === 'DOCUMENT' || t === 'FILE' ? 'document'
    : t === 'AGENDA' || t === 'AGENDA_ITEM' ? 'agenda' : t === 'EQUIPMENT' ? 'equipment' : t === 'ROOM' || t === 'SUBSTRUCTURE' ? 'room'
      : t === 'OPERATION' ? 'operation' : null;
  return kind ? { kind, id: Number(c.target_id) } : null;
}

/** La cible est-elle en consultation seule (bien transmis) ? Lecture seule, sans effet. */
export async function estEnLectureSeule(accountId: number, target: ReadOnlyTarget, runner?: Runner): Promise<boolean> {
  const r = runner ?? (await runnerParDefaut());
  if (target.kind === 'toProcessCard') {
    const c = await cibleDeCarte(r, String(target.id), accountId);
    return c ? estEnLectureSeule(accountId, c, r) : false;
  }
  if (target.kind !== 'documentPublicId' && !(Number.isSafeInteger(Number(target.id)) && Number(target.id) > 0)) return false;
  if (target.kind === 'asset' || target.kind === 'room' || target.kind === 'equipment') {
    const rows = (await r.unsafe(
      `SELECT EXISTS (SELECT 1 FROM (${PORTEUR[target.kind]}) b JOIN assets a ON a.id = b.asset_id
                       WHERE a.deleted_at IS NULL AND a.status = 'TRANSMIS') AS bloque`,
      [String(target.id), accountId] as never[],
    )) as Array<{ bloque: boolean }>;
    return rows[0]?.bloque === true;
  }
  const biens = BIENS[target.kind];
  const rows = (await r.unsafe(
    `WITH biens AS (${biens})
     SELECT (EXISTS (SELECT 1 FROM biens b JOIN assets a ON a.id = b.asset_id WHERE a.deleted_at IS NULL AND a.status = 'TRANSMIS')
             AND NOT EXISTS (SELECT 1 FROM biens b JOIN assets a ON a.id = b.asset_id WHERE a.deleted_at IS NULL AND a.status IS DISTINCT FROM 'TRANSMIS')) AS bloque`,
    [String(target.id), accountId] as never[],
  )) as Array<{ bloque: boolean }>;
  return rows[0]?.bloque === true;
}

/** Une des cibles est-elle en consultation seule ? */
export async function uneCibleEnLectureSeule(accountId: number, targets: readonly ReadOnlyTarget[], runner?: Runner): Promise<ReadOnlyTarget | null> {
  for (const t of targets) if (await estEnLectureSeule(accountId, t, runner)) return t;
  return null;
}

export function reponseLectureSeule(target?: ReadOnlyTarget | null): NextResponse {
  return NextResponse.json(
    { error: ASSET_READ_ONLY_MESSAGE, code: 'ASSET_READ_ONLY', message: ASSET_READ_ONLY_MESSAGE, details: { status: 'TRANSMIS', ...(target ? { target: target.kind } : {}) } },
    { status: 403 },
  );
}

/**
 * #849 (A2) — refus prêt à renvoyer si le DOCUMENT ne vise que des biens
 * TRANSMIS. `null` : écriture permise (ou document inconnu : la route répond).
 */
export async function refuserSiDocumentDeBienTransmis(fileId: number, accountId: number): Promise<NextResponse | null> {
  return (await estEnLectureSeule(accountId, { kind: 'document', id: fileId })) ? reponseLectureSeule({ kind: 'document', id: fileId }) : null;
}

/** Description de la cible d'une route d'écriture (paramètre de chemin et / ou champs du corps JSON). */
export interface RouteReadOnlySpec {
  /** Cible portée par le paramètre de chemin `param` (défaut `id`). */
  kind?: ReadOnlyTargetKind;
  param?: string;
  /** Cible portée par un paramètre de requête (`?id=`) — routes historiques. */
  query?: { name: string; kind: ReadOnlyTargetKind };
  /** Cibles additionnelles lues dans le corps JSON : `{ champ: type }` (valeur unique ou tableau). */
  body?: Record<string, ReadOnlyTargetKind>;
}

/**
 * GARDE DE ROUTE — à appeler en TÊTE de chaque handler d'écriture qui touche
 * un bien, ses pièces, équipements, documents, Opérations ou son Agenda.
 * Session illisible, cible inconnue ou d'un autre compte : `null` (la route
 * applique ses propres contrôles d'authentification et d'appartenance).
 */
export async function refuserSiRequeteSurBienTransmis(
  request: Request,
  context: { params?: Promise<Record<string, string | string[]>> | Record<string, string | string[]> } | undefined,
  spec: RouteReadOnlySpec,
): Promise<NextResponse | null> {
  let accountId: number | null = null;
  try {
    const { SessionService } = await import('@/lib/session-service');
    const s = await SessionService.getSession(request as never);
    accountId = (s as { currentAccountId?: number | null } | null)?.currentAccountId ?? null;
  } catch {
    return null;
  }
  if (!accountId) return null;
  const cibles: ReadOnlyTarget[] = [];
  if (spec.kind) {
    const params = context?.params ? await context.params : {};
    const v = (params as Record<string, string | string[]>)[spec.param ?? 'id'];
    const id = Array.isArray(v) ? v[0] : v;
    if (id !== undefined && id !== null && id !== '') cibles.push({ kind: spec.kind, id: spec.kind === 'documentPublicId' || spec.kind === 'toProcessCard' ? String(id) : Number(id) });
  }
  if (spec.query) {
    const v = new URL(request.url).searchParams.get(spec.query.name);
    if (v) cibles.push({ kind: spec.query.kind, id: Number(v) });
  }
  if (spec.body) {
    let corps: Record<string, unknown> = {};
    try { corps = (await request.clone().json()) as Record<string, unknown>; } catch { corps = {}; }
    for (const [champ, kind] of Object.entries(spec.body)) {
      const v = corps?.[champ];
      for (const x of Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]) {
        if (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) cibles.push({ kind, id: typeof x === 'number' ? x : (kind === 'documentPublicId' || kind === 'toProcessCard' ? x : Number(x)) });
      }
    }
  }
  const bloque = await uneCibleEnLectureSeule(accountId, cibles);
  return bloque ? reponseLectureSeule(bloque) : null;
}

/**
 * Traitement automatique (T1, T3, T4, jobs) : abstention JOURNALISÉE sur une
 * cible en consultation seule — rend `true` si le traitement doit s'abstenir.
 * Ne lève jamais (une lecture en échec n'empêche pas les autres biens du lot).
 */
export async function abstentionSiLectureSeule(
  accountId: number, target: ReadOnlyTarget, traitement: string, runner?: Runner,
): Promise<boolean> {
  try {
    if (!(await estEnLectureSeule(accountId, target, runner))) return false;
    console.info(JSON.stringify({ event: 'asset_read_only.skip', treatment: traitement, accountId, target: target.kind, id: target.id, reason: 'ASSET_READ_ONLY' }));
    return true;
  } catch (e) {
    console.error(`[asset-read-only] ${traitement} : contrôle impossible (${target.kind} ${target.id}) :`, (e as Error).message);
    return false;
  }
}
