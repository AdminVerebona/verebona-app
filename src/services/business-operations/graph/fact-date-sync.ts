/**
 * SYNCHRONISATION BIDIRECTIONNELLE DE LA DATE D'UN MÊME FAIT (lot 116C, carte
 * Trello #806 §5 ; CDC « Opérations / Agenda V2.0 » §11 ; AC34).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION DU PO (carte #806) — deux affichages du MÊME fait métier daté
 * (l'opération et l'événement de l'Agenda) se synchronisent dans les deux sens
 * après une correction, avec identité du fait, provenance, version et journal.
 *
 * L'IDENTITÉ DU FAIT est celle que le modèle porte déjà : le FAIT PORTÉ par le
 * lien N↔N (`business_operation_agenda_links.fact_key`, migration 1721). Un
 * événement de l'Agenda qui PORTE le fait d'une opération en est l'affichage
 * daté ; tout autre événement relié est un membre à SA propre date et n'est
 * jamais synchronisé. La date de l'opération qui correspond au fait est donnée
 * par la table de projection existante (C16, `agenda-projection/model.ts ›
 * decideProjection`) — reprise ici en une règle pure, sans rien y ajouter :
 *
 *   fait porté      état interne   date de l'opération
 *   ACQUISITION     réalisé        date de réalisation (entrée en possession)
 *   DISPOSAL        réalisé        date de réalisation (sortie)
 *   CLAIM           réalisé        date de réalisation (survenance)
 *   INTERVENTION    réalisé        date de réalisation
 *   INTERVENTION    envisagé       date prévue
 *
 * JAMAIS ENTRE FAITS DIFFÉRENTS. Ne sont donc jamais synchronisés :
 *   · un événement relié qui ne porte aucun fait (un devis, une visite, une
 *     étape : devis ≠ réalisation) ;
 *   · la date de début ou de fin d'une opération (signature ≠ prise d'effet,
 *     prise d'effet ≠ début de couverture) : aucun fait porté ne leur correspond ;
 *   · l'échéance « fin de contrat » (`CONTRACT:END`) : sa date est la fin
 *     d'effet du contrat, établie par les seules sources contractuelles — hors
 *     de cette synchronisation (limite écrite dans la fiche de recette) ;
 *   · la date de présentation (CDC §11) : calculée à la lecture, jamais stockée,
 *     jamais une échéance.
 *
 * GARDES
 *   · MÊME VALEUR AVANT : la synchronisation n'a lieu que si les deux affichages
 *     montraient la même date avant la correction (ou si l'autre n'en avait
 *     aucune du côté opération). Deux dates déjà divergentes ne sont pas un
 *     même affichage : rien n'est écrasé, l'abstention est tracée une fois.
 *   · AUCUNE DATE INVENTÉE NI EFFACÉE : seule une date complète saisie par
 *     l'utilisateur est reportée ; retirer une date d'un côté ne retire rien de
 *     l'autre.
 *   · AUCUNE BOUCLE : chaque sens n'écrit que si la valeur diffère et n'appelle
 *     pas l'autre ; l'écriture reportée rend les deux égales, donc tout passage
 *     suivant (T4, T3, rejeu) ne trouve plus rien à faire.
 *   · PAS DE RAPPEL EN DOUBLE : l'événement est écrit par la primitive unique
 *     de l'Agenda (`writeAgendaItem`), qui réévalue SON rappel (couverture
 *     existante remplacée, jamais ajoutée) ; aucun événement n'est créé.
 *   · LA CORRECTION MANUELLE N'EST PAS RÉÉCRITE PAR L'IA : côté opération, la
 *     source de protection de `correctOperation` est posée (T3 ne recalcule
 *     plus la date) ; côté Agenda, l'événement devient « modifié par
 *     l'utilisateur » (T4 ne le réécrit plus).
 *   · ISOLATION : tout est relu dans le compte.
 * PROVENANCE, VERSION, JOURNAL : chaque report écrit une ligne du journal du
 * graphe (lien concerné, fait, sens, avant / après, auteur) ; la version de
 * l'opération et celle du lien avancent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { BusinessOperationStatus } from '../model';
import type { GroupingRunner } from '../grouping/runner';

// ── Règle pure ─────────────────────────────────────────────────────────────

export type SyncedDateField = 'realizedDate' | 'plannedDate';

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
/** Date civile COMPLÈTE et réelle (AAAA-MM-JJ ; le 30 février n'en est pas une). */
export const isFullDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !JOUR.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/**
 * Date de l'opération qui est LE MÊME FAIT que l'événement porteur de
 * `factKey` (pure ; table C16). `null` : aucun fait daté commun — jamais de
 * synchronisation.
 */
export function syncedOperationDateField(typeCode: string | null, status: BusinessOperationStatus | string | null, factKey: string | null): SyncedDateField | null {
  if (!typeCode || !factKey || factKey !== typeCode) return null;
  switch (typeCode) {
    case 'ACQUISITION':
    case 'DISPOSAL':
    case 'CLAIM':
      return status === 'REALIZED' ? 'realizedDate' : null;
    case 'INTERVENTION':
      return status === 'REALIZED' ? 'realizedDate' : status === 'ENVISAGED' ? 'plannedDate' : null;
    default:
      return null;
  }
}

export type FactDateSyncDirection = 'AGENDA_TO_OPERATION' | 'OPERATION_TO_AGENDA';

export interface FactDateSyncLine {
  operationId: number;
  agendaItemId: number;
  factKey: string;
  field: SyncedDateField;
  direction: FactDateSyncDirection;
  /** SYNCED : date reportée ; ALREADY_EQUAL : rien à faire ; DIVERGENT : les deux affichages différaient déjà — rien n'est écrasé ; PROTECTED / FAILED : non reportée. */
  outcome: 'SYNCED' | 'ALREADY_EQUAL' | 'DIVERGENT' | 'PROTECTED' | 'FAILED';
  before: string | null;
  after: string | null;
}

/** Motifs du journal du graphe. */
export const FACT_DATE_SYNC_REASON = 'FACT_DATE_SYNC';
export const FACT_DATE_SYNC_DIVERGENT_REASON = 'ABSTAIN_FACT_DATE_DIVERGENT';
/**
 * Carte #831 (E04) — REPORT IMPOSSIBLE, ÉTAT HONNÊTE.
 *
 * L'écriture de départ est déjà enregistrée (correction de l'utilisateur) et
 * le report vers l'autre affichage a échoué : l'échec est écrit DURABLEMENT
 * ici, en AJOUT seul (`NO_CHANGE` : rien n'a changé), au lieu d'être
 * seulement affiché dans la sortie du serveur. La reprise est assurée par le
 * contrôle de cohérence `COH-OPS-FACT-DATE-SYNC`, qui relit L'ÉTAT des deux
 * côtés (jamais ce seul journal) et rejoue le report quand l'autre affichage
 * montre encore la valeur d'avant.
 */
export const FACT_DATE_SYNC_FAILED_REASON = 'FACT_DATE_SYNC_FAILED';

/** Message d'erreur borné : ni donnée client, ni secret, ni trace complète. */
const motifBorne = (e: unknown): string => {
  const x = e as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof x?.code === 'string' && x.code ? x.code : typeof x?.name === 'string' ? x.name : 'ERROR';
  return `${code}: ${String(x?.message ?? '').slice(0, 160)}`;
};

/**
 * Trace durable d'un report impossible, sur une connexion PROPRE (la
 * transaction du report est annulée quand il y en avait une). Ne lève jamais :
 * une trace manquante ne doit pas masquer l'écriture déjà faite, et l'écart
 * reste constaté sur l'état par le contrôle de cohérence.
 */
async function traceReportImpossible(p: {
  accountId: number; operationId: number; agendaItemId: number | null; direction: FactDateSyncDirection;
  field: SyncedDateField | null; factKey: string | null; before: string | null; after: string | null; actorUserId: number | null; cause: unknown;
}): Promise<void> {
  try {
    const [{ db }, { drizzleRunner }, store] = await Promise.all([
      import('@/db'), import('../grouping/runner'), import('./store'),
    ]);
    await store.journalGraph(drizzleRunner(db), p.accountId, {
      relationKind: 'AGENDA_LINK', operationId: p.operationId, agendaItemId: p.agendaItemId,
      action: 'NO_CHANGE', origin: 'SYSTEM', channel: p.direction === 'AGENDA_TO_OPERATION' ? 'AGENDA' : 'OPERATION',
      actorUserId: p.actorUserId, reasonCode: FACT_DATE_SYNC_FAILED_REASON, evidence: [],
      before: { factKey: p.factKey, field: p.field, direction: p.direction, sourceBefore: p.before },
      after: { failed: true, factKey: p.factKey, field: p.field, direction: p.direction, sourceAfter: p.after, cause: motifBorne(p.cause) },
      inputHash: `fact-date-failed:${p.direction}:${p.operationId}:${p.agendaItemId ?? 0}:${p.field ?? ''}:${p.after ?? ''}`,
    });
  } catch {
    // La trace est un confort de supervision : l'écart lui-même est porté par l'ÉTAT des deux côtés.
  }
}

/**
 * Dernier changement de date DURABLEMENT journalisé d'un côté : l'image avant /
 * après écrite dans la même transaction que l'écriture elle-même (journal du
 * graphe pour l'opération, trace d'occurrence pour l'Agenda).
 */
export interface FactDateLastChange {
  before: string | null;
  after: string | null;
  /** Horodatage comparable (ISO) du changement. */
  at: string;
}

/** Carte #831 (E04) — issue d'un examen de reprise. */
export type FactDateRepair =
  /** Les deux affichages montrent la même date : rien à faire. */
  | { kind: 'CONSISTENT' }
  /** Le report peut être rejoué : l'autre affichage montre encore la valeur d'avant. */
  | { kind: 'REPLAY'; direction: FactDateSyncDirection; before: string | null; after: string }
  /** Les deux côtés ont bougé : aucune écriture, l'abstention tracée reste seule juge. */
  | { kind: 'DIVERGENT' }
  /** Aucun changement journalisé n'explique l'écart : constat, jamais d'écriture. */
  | { kind: 'UNKNOWN' };

/**
 * REPRISE D'UN REPORT (pure, carte #831 E04).
 *
 * Deux affichages du même fait montrent des dates différentes. Lequel a été
 * corrigé, et l'autre peut-il encore être aligné sans rien écraser ?
 *
 *   · le côté SOURCE est celui dont le dernier changement journalisé est le
 *     plus récent ET dont la valeur d'après est bien ce qu'il montre
 *     aujourd'hui (preuve que ce changement est le vivant) ;
 *   · le report n'est rejoué que si l'autre côté montre ENCORE la valeur
 *     d'avant de ce changement — c'est exactement la garde « même valeur
 *     avant » du report initial (`decideFactDateSync`) ;
 *   · sinon les deux ont bougé : DIVERGENT, rien n'est écrit ;
 *   · sans changement journalisé exploitable : UNKNOWN, rien n'est écrit.
 *
 * Un événement d'Agenda SANS date ne reçoit jamais une date d'office (« Sans
 * échéance » est un choix de l'utilisateur) ; une opération sans date, elle,
 * peut être complétée — mêmes règles que le report initial.
 */
export function decideFactDateRepair(s: {
  agendaDate: string | null;
  operationDate: string | null;
  operationChange: FactDateLastChange | null;
  agendaChange: FactDateLastChange | null;
}): FactDateRepair {
  if (s.agendaDate === s.operationDate) return { kind: 'CONSISTENT' };
  const vivant = (c: FactDateLastChange | null, montre: string | null) => (c && c.after === montre ? c : null);
  const op = vivant(s.operationChange, s.operationDate);
  const ag = vivant(s.agendaChange, s.agendaDate);
  if (!op && !ag) return { kind: 'UNKNOWN' };
  const source: FactDateSyncDirection = !ag ? 'OPERATION_TO_AGENDA'
    : !op ? 'AGENDA_TO_OPERATION'
      : op.at >= ag.at ? 'OPERATION_TO_AGENDA' : 'AGENDA_TO_OPERATION';
  const c = (source === 'OPERATION_TO_AGENDA' ? op : ag)!;
  if (!isFullDate(c.after)) return { kind: 'UNKNOWN' };
  const cible = source === 'OPERATION_TO_AGENDA' ? s.agendaDate : s.operationDate;
  const d = decideFactDateSync({
    sourceBefore: c.before, sourceAfter: c.after, target: cible,
    // Un événement d'Agenda sans date garde son « Sans échéance » ; une opération sans date peut être complétée.
    targetMayBeEmpty: source === 'AGENDA_TO_OPERATION',
  });
  if (d === 'ALREADY_EQUAL') return { kind: 'CONSISTENT' };
  if (d === 'SYNC') return { kind: 'REPLAY', direction: source, before: c.before, after: c.after };
  if (d === 'DIVERGENT') return { kind: 'DIVERGENT' };
  return { kind: 'UNKNOWN' };
}

/** Décision d'un report (pure) : `source` vient d'être corrigée de `sourceBefore` à `sourceAfter` ; `target` est l'autre affichage. */
export function decideFactDateSync(p: { sourceBefore: string | null; sourceAfter: string | null; target: string | null; targetMayBeEmpty: boolean }): 'SYNC' | 'ALREADY_EQUAL' | 'DIVERGENT' | 'NOTHING' {
  if (!isFullDate(p.sourceAfter)) return 'NOTHING';
  if (p.target === p.sourceAfter) return 'ALREADY_EQUAL';
  if (p.target === null) return p.targetMayBeEmpty ? 'SYNC' : 'DIVERGENT';
  return p.target === p.sourceBefore ? 'SYNC' : 'DIVERGENT';
}

// ── Accès aux données ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);
const texte = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const COLONNE: Readonly<Record<SyncedDateField, string>> = { realizedDate: 'realized_date', plannedDate: 'planned_date' };

/**
 * AGENDA → OPÉRATION : l'utilisateur vient de corriger la date d'un événement
 * de l'Agenda (`updateAgendaItem`). Pour chaque opération dont cet événement
 * PORTE le fait, la date correspondante de l'opération est alignée. Appelée
 * APRÈS l'écriture de l'événement ; une transaction par appel, sous le verrou
 * des Opérations du compte. Ne lève jamais (l'événement est déjà enregistré).
 */
export async function syncAgendaDateToOperations(p: {
  accountId: number; agendaItemId: number; previousDate: string | null; newDate: string | null; actorUserId: number | null;
}): Promise<FactDateSyncLine[]> {
  const out: FactDateSyncLine[] = [];
  if (!isFullDate(p.newDate) || p.newDate === p.previousDate) return out;
  const nouvelle = p.newDate;
  try {
    // Carte #831 (E04) : la transaction ci-dessous est tout-ou-rien. Les routes
    // concernées sont relevées AVANT, en lecture seule, pour que l'échec soit
    // tracé durablement route par route (`traceReportImpossible`) au lieu de
    // n'exister que dans la sortie du serveur.
    const [{ withGroupingWrite }, { lockGroupingAccount }, store, { declarationFingerprint }, { PAGE_CORRECTION_DECLARATION_TEXT }] = await Promise.all([
      import('../grouping/service'), import('../grouping/runner'), import('./store'), import('./model'), import('./reference-event-page'),
    ]);
    await withGroupingWrite(p.accountId, async (g) => {
      await lockGroupingAccount(g.runner, p.accountId);
      const porteurs = await g.runner.q<Row>(
        `SELECT l.operation_id, l.fact_key, o.type_code, o.status, o.realized_date::text AS realized_date, o.planned_date::text AS planned_date, o.version
           FROM business_operation_agenda_links l
           JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
           JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
          WHERE l.account_id = $1 AND l.agenda_item_id = $2 AND l.state = 'ACTIVE' AND l.fact_key IS NOT NULL
          ORDER BY l.operation_id FOR UPDATE OF o`, [p.accountId, p.agendaItemId]);
      if (!porteurs.length) return;
      if (!g.session) throw new Error('fact-date-sync : écriture Opération non ouverte');
      const repo = g.session.repository(p.accountId);
      for (const x of porteurs) {
        const operationId = n(x.operation_id);
        const factKey = String(x.fact_key);
        const field = syncedOperationDateField(texte(x.type_code), texte(x.status), factKey);
        if (!field) continue;
        const actuelle = texte(x[COLONNE[field]]);
        const base = { operationId, agendaItemId: p.agendaItemId, factKey, field, direction: 'AGENDA_TO_OPERATION' as const };
        const d = decideFactDateSync({ sourceBefore: p.previousDate, sourceAfter: nouvelle, target: actuelle, targetMayBeEmpty: true });
        if (d === 'NOTHING') continue;
        if (d === 'ALREADY_EQUAL') { out.push({ ...base, outcome: 'ALREADY_EQUAL', before: actuelle, after: actuelle }); continue; }
        if (d === 'DIVERGENT') {
          await store.recordAiAbstention(g.runner, p.accountId, {
            relationKind: 'AGENDA_LINK', operationId, agendaItemId: p.agendaItemId, reasonCode: FACT_DATE_SYNC_DIVERGENT_REASON,
            situationHash: `fact-date:${factKey}:${field}:${actuelle ?? ''}:${nouvelle}`, origin: 'SYSTEM', channel: 'AGENDA',
            detail: { factKey, field, operationDate: actuelle, agendaDateBefore: p.previousDate, agendaDateAfter: nouvelle }, correlationId: g.correlationId,
          });
          out.push({ ...base, outcome: 'DIVERGENT', before: actuelle, after: actuelle });
          continue;
        }
        const change = await repo.updateAttributes(operationId, field === 'realizedDate' ? { realizedDate: nouvelle } : { plannedDate: nouvelle }, FACT_DATE_SYNC_REASON);
        if (!change) { out.push({ ...base, outcome: 'ALREADY_EQUAL', before: actuelle, after: actuelle }); continue; }
        // La correction de l'utilisateur n'est plus recalculée par T3 : même source de protection que la correction depuis la fiche.
        let declarationId: number | null = null;
        const [protegee] = await g.runner.q(
          `SELECT 1 FROM business_operation_sources WHERE operation_id = $1 AND account_id = $2 AND active AND source_kind = 'USER_DECLARATION' LIMIT 1`,
          [operationId, p.accountId]);
        if (!protegee) {
          declarationId = await store.insertDeclaration(g.runner, p.accountId, {
            purpose: 'UPDATE', channel: 'UI', userId: p.actorUserId, text: PAGE_CORRECTION_DECLARATION_TEXT,
            fingerprint: declarationFingerprint(PAGE_CORRECTION_DECLARATION_TEXT), operationId,
          });
          await repo.addSource(operationId, { kind: 'USER_DECLARATION', entityKey: declarationId, authority: 'USER', locator: { declaration: 'UPDATE', origin: 'AGENDA_DATE' } }, FACT_DATE_SYNC_REASON);
        }
        const versionLien = await store.bumpAgendaLinkVersion(g.runner, p.accountId, operationId, p.agendaItemId);
        const [apres] = await g.runner.q<Row>(`SELECT version FROM business_operations WHERE id = $1 AND account_id = $2`, [operationId, p.accountId]);
        await store.journalGraph(g.runner, p.accountId, {
          relationKind: 'AGENDA_LINK', operationId, agendaItemId: p.agendaItemId, action: 'UPDATED', origin: 'USER', channel: 'AGENDA',
          actorUserId: p.actorUserId, reasonCode: FACT_DATE_SYNC_REASON, correlationId: g.correlationId,
          evidence: declarationId !== null ? [{ kind: 'USER_DECLARATION', ref: String(declarationId) }] : [{ kind: 'AGENDA', ref: String(p.agendaItemId) }],
          before: { factKey, field, direction: base.direction, operationDate: actuelle, agendaDate: p.previousDate, operationVersion: n(x.version) },
          after: { factKey, field, direction: base.direction, operationDate: nouvelle, agendaDate: nouvelle, operationVersion: n(apres?.version ?? x.version), linkVersion: versionLien },
        });
        out.push({ ...base, outcome: 'SYNCED', before: actuelle, after: nouvelle });
      }
    }, { actorUserId: p.actorUserId });
  } catch (e) {
    console.error(`[fact-date-sync] événement ${p.agendaItemId} (compte ${p.accountId}) : date non reportée sur l’opération :`, (e as Error).message);
    // Carte #831 (E04) — ÉTAT HONNÊTE. La transaction est annulée : rien n'a été
    // reporté. Les routes concernées sont relues sur une connexion propre et
    // l'échec est écrit durablement pour chacune, avec la valeur d'avant et
    // celle d'après : le contrôle COH-OPS-FACT-DATE-SYNC rejoue le report tant
    // que l'opération montre encore la date d'avant. Une erreur ici ne masque
    // jamais l'événement déjà enregistré.
    const echecs = await routesPorteusesDeLEvenement(p.accountId, p.agendaItemId);
    for (const r of echecs) {
      await traceReportImpossible({
        accountId: p.accountId, operationId: r.operationId, agendaItemId: p.agendaItemId, direction: 'AGENDA_TO_OPERATION',
        field: r.field, factKey: r.factKey, before: p.previousDate, after: nouvelle, actorUserId: p.actorUserId, cause: e,
      });
    }
    if (!echecs.length) {
      return [{ operationId: 0, agendaItemId: p.agendaItemId, factKey: '', field: 'realizedDate', direction: 'AGENDA_TO_OPERATION', outcome: 'FAILED', before: null, after: null }];
    }
    return echecs.map((r) => ({
      operationId: r.operationId, agendaItemId: p.agendaItemId, factKey: r.factKey, field: r.field,
      direction: 'AGENDA_TO_OPERATION' as const, outcome: 'FAILED' as const, before: null, after: null,
    }));
  }
  return out;
}

/**
 * Routes dont CET événement porte le fait (lecture seule, connexion propre) :
 * sert à tracer un échec route par route. Rend une liste vide si la lecture
 * elle-même échoue — on ne remplace jamais une panne par une invention.
 */
async function routesPorteusesDeLEvenement(
  accountId: number, agendaItemId: number,
): Promise<Array<{ operationId: number; factKey: string; field: SyncedDateField }>> {
  try {
    const [{ db }, { drizzleRunner }] = await Promise.all([import('@/db'), import('../grouping/runner')]);
    const lignes = await drizzleRunner(db).q<Row>(
      `SELECT l.operation_id, l.fact_key, o.type_code, o.status
         FROM business_operation_agenda_links l
         JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        WHERE l.account_id = $1 AND l.agenda_item_id = $2 AND l.state = 'ACTIVE' AND l.fact_key IS NOT NULL
        ORDER BY l.operation_id`, [accountId, agendaItemId]);
    const out: Array<{ operationId: number; factKey: string; field: SyncedDateField }> = [];
    for (const x of lignes) {
      const factKey = String(x.fact_key);
      const field = syncedOperationDateField(texte(x.type_code), texte(x.status), factKey);
      if (field) out.push({ operationId: n(x.operation_id), factKey, field });
    }
    return out;
  } catch {
    return [];
  }
}

/** Dates d'une opération concernées par la synchronisation (avant ou après une correction). */
export type OperationSyncedDates = Partial<Record<SyncedDateField, string | null>>;

/**
 * OPÉRATION → AGENDA : l'utilisateur vient de corriger une date de l'opération
 * (commandes `correctOperation` / `updateOperation` de la façade, APRÈS leur
 * validation). L'événement de l'Agenda qui PORTE le fait correspondant est
 * aligné s'il montrait la même date avant. Ne lève jamais (la correction de
 * l'opération est déjà enregistrée).
 */
export async function syncOperationDatesToAgenda(p: {
  accountId: number; operationId: number; before: OperationSyncedDates; after: OperationSyncedDates; actorUserId: number | null;
}): Promise<FactDateSyncLine[]> {
  const out: FactDateSyncLine[] = [];
  const champs = (Object.keys(COLONNE) as SyncedDateField[]).filter((f) => isFullDate(p.after[f]) && p.after[f] !== (p.before[f] ?? null));
  if (!champs.length) return out;
  let r: GroupingRunner;
  let store: typeof import('./store');
  let porteurs: Row[];
  try {
    const [{ db }, { drizzleRunner }, s] = await Promise.all([import('@/db'), import('../grouping/runner'), import('./store')]);
    store = s;
    r = drizzleRunner(db);
    porteurs = await r.q<Row>(
      `SELECT l.agenda_item_id, l.fact_key, o.type_code, o.status, o.version, i.start_date::text AS start_date, i.is_automatic
         FROM business_operation_agenda_links l
         JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
         JOIN business_operations o ON o.id = l.operation_id AND o.account_id = l.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
        WHERE l.account_id = $1 AND l.operation_id = $2 AND l.state = 'ACTIVE' AND l.fact_key IS NOT NULL
        ORDER BY l.agenda_item_id`, [p.accountId, p.operationId]);
  } catch (e) {
    // Carte #831 (E04) : les routes ne sont même pas connues — échec tracé pour l'opération, reprise par COH-OPS-FACT-DATE-SYNC.
    console.error(`[fact-date-sync] opération ${p.operationId} (compte ${p.accountId}) : routes porteuses illisibles :`, (e as Error).message);
    await traceReportImpossible({
      accountId: p.accountId, operationId: p.operationId, agendaItemId: null, direction: 'OPERATION_TO_AGENDA',
      field: null, factKey: null, before: null, after: null, actorUserId: p.actorUserId, cause: e,
    });
    out.push({ operationId: p.operationId, agendaItemId: 0, factKey: '', field: 'realizedDate', direction: 'OPERATION_TO_AGENDA', outcome: 'FAILED', before: null, after: null });
    return out;
  }
  for (const x of porteurs) {
    const agendaItemId = n(x.agenda_item_id);
    const factKey = String(x.fact_key);
    const field = syncedOperationDateField(texte(x.type_code), texte(x.status), factKey);
    if (!field || !champs.includes(field)) continue;
    const nouvelle = p.after[field] as string;
    const avant = p.before[field] ?? null;
    const actuelle = texte(x.start_date);
    const base = { operationId: p.operationId, agendaItemId, factKey, field, direction: 'OPERATION_TO_AGENDA' as const };
    // Un événement SANS date n'en reçoit pas d'office (« Sans échéance » est un choix de l'utilisateur).
    const d = decideFactDateSync({ sourceBefore: avant, sourceAfter: nouvelle, target: actuelle, targetMayBeEmpty: false });
    if (d === 'NOTHING') continue;
    if (d === 'ALREADY_EQUAL') { out.push({ ...base, outcome: 'ALREADY_EQUAL', before: actuelle, after: actuelle }); continue; }
    // Carte #831 (E04) : chaque route est indépendante — une route en échec n'emporte
    // plus les suivantes, et son échec est écrit durablement (il était seulement
    // affiché dans la sortie du serveur, donc perdu).
    try {
      if (d === 'DIVERGENT') {
        await store.recordAiAbstention(r, p.accountId, {
          relationKind: 'AGENDA_LINK', operationId: p.operationId, agendaItemId, reasonCode: FACT_DATE_SYNC_DIVERGENT_REASON,
          situationHash: `fact-date:${factKey}:${field}:${actuelle ?? ''}:${nouvelle}`, origin: 'SYSTEM', channel: 'OPERATION',
          detail: { factKey, field, agendaDate: actuelle, operationDateBefore: avant, operationDateAfter: nouvelle },
        });
        out.push({ ...base, outcome: 'DIVERGENT', before: actuelle, after: actuelle });
        continue;
      }
      // Primitive unique de l'Agenda : la date seule est écrite ; le rappel de CET événement est réévalué par elle
      // (aucun événement créé, aucun rappel ajouté). Un événement automatique devient « modifié par l'utilisateur ».
      const { writeAgendaItem } = await import('@/services/agenda/write-agenda-item');
      await writeAgendaItem(
        { itemId: agendaItemId, values: { startDate: nouvelle, dateSource: 'USER', ...(x.is_automatic === true ? { isAutomaticModified: true } : {}), updatedAt: new Date() } },
        { accountId: p.accountId, actorUserId: p.actorUserId, channel: 'MANUAL', notify: false, statusProposal: false },
      );
      const versionLien = await store.bumpAgendaLinkVersion(r, p.accountId, p.operationId, agendaItemId);
      await store.journalGraph(r, p.accountId, {
        relationKind: 'AGENDA_LINK', operationId: p.operationId, agendaItemId, action: 'UPDATED', origin: 'USER', channel: 'OPERATION',
        actorUserId: p.actorUserId, reasonCode: FACT_DATE_SYNC_REASON, evidence: [{ kind: 'AGENDA', ref: String(agendaItemId) }],
        before: { factKey, field, direction: base.direction, operationDate: avant, agendaDate: actuelle },
        after: { factKey, field, direction: base.direction, operationDate: nouvelle, agendaDate: nouvelle, operationVersion: n(x.version), linkVersion: versionLien },
      });
      out.push({ ...base, outcome: 'SYNCED', before: actuelle, after: nouvelle });
    } catch (e) {
      console.error(`[fact-date-sync] opération ${p.operationId} → événement ${agendaItemId} (compte ${p.accountId}) : date non reportée :`, (e as Error).message);
      await traceReportImpossible({
        accountId: p.accountId, operationId: p.operationId, agendaItemId, direction: 'OPERATION_TO_AGENDA',
        field, factKey, before: avant, after: nouvelle, actorUserId: p.actorUserId, cause: e,
      });
      out.push({ ...base, outcome: 'FAILED', before: actuelle, after: null });
    }
  }
  return out;
}
