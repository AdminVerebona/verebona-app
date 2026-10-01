/**
 * MIG-05, MIG-06, MIG-08 — orchestration des rattrapages DÉJÀ livrés, sans
 * les réécrire (CDC 15 §14 points 5, 6, 8) :
 *
 *   MIG-05  liens agenda ↔ documents — `backfillAgendaSourceLinks`
 *           (`scripts/agenda-backfill.ts source-links`), simulation native ;
 *   MIG-06  dédoublonnage des événements automatiques —
 *           `dedupeAutomaticAgendaItems` (`agenda-backfill.ts dedupe`),
 *           simulation native, éléments manuels ou modifiés protégés ;
 *   MIG-08  `document_asset_links` — `backfillDocumentAssetLinks`
 *           (`scripts/backfill-document-asset-links.ts`). Ce service N'A PAS
 *           de simulation : en dry-run, une ESTIMATION en lecture seule
 *           (documents dont une colonne vise un bien sans lien ACTIF vers
 *           lui) est rapportée, rien n'est écrit.
 *
 * Ces trois services parcourent TOUTE la base (pas de filtre par compte) :
 * avec `--account`, les étapes sont ignorées et le rapport le dit.
 * Leurs cas inexploitables sont repris au rapport 0225 (AMBIGUOUS), leurs
 * retraits protégés en SKIPPED_USER.
 */
import { backfillAgendaSourceLinks, dedupeAutomaticAgendaItems } from '@/services/agenda/backfill/agenda-backfill';
import { backfillDocumentAssetLinks } from '@/services/documents/document-asset-links/backfill';
import { emptyCounts, type Decision, type MigStep, type ReportEntry, type StepContext, type StepResult } from '../types';

function ignoreeParCompte(step: MigStep, ctx: StepContext): StepResult | null {
  if (ctx.accountId == null) return null;
  return { step, scanned: 0, counts: emptyCounts(), cursor: 0, cards: 0, skipped: 'ACCOUNT_FILTER_UNSUPPORTED', complete: true };
}

/**
 * Curseurs remontés par les services (rappel synchrone) : enregistrés dans
 * l'ordre, attendus avant la fin de l'étape ; un échec d'enregistrement est
 * journalisé et remonté (la reprise ne doit pas partir d'un curseur faux).
 */
function curseurs(ctx: StepContext, part?: string) {
  let chaine: Promise<void> = Promise.resolve();
  let erreur: Error | null = null;
  return {
    noter(c: number) {
      chaine = chaine.then(() => ctx.checkpoint(c, part)).catch((e: Error) => { erreur ??= e; ctx.log(`curseur non enregistré : ${e.message}`); });
    },
    async fin() {
      await chaine;
      if (erreur) throw erreur;
    },
  };
}

async function rapporter(ctx: StepContext, counts: Record<Decision, number>, e: ReportEntry) {
  counts[e.decision] += 1;
  await ctx.report(e);
}

export async function runMig05(ctx: StepContext): Promise<StepResult> {
  const step = 'MIG-05' as const;
  const ignoree = ignoreeParCompte(step, ctx);
  if (ignoree) return ignoree;
  const counts = emptyCounts();
  const cur = curseurs(ctx);
  const r = await backfillAgendaSourceLinks(ctx.sql, {
    apply: ctx.apply, batchSize: ctx.batchSize, fromItemId: ctx.fromCursor,
    onProgress: ({ cursor, done }) => { ctx.log(`${step} : ${done} élément(s), curseur ${cursor}`); cur.noter(cursor); },
  });
  await cur.fin();
  for (const o of r.orphans) {
    await rapporter(ctx, counts, { step, accountId: o.accountId, entityType: 'agenda_item', entityId: o.agendaItemId,
      before: { originRefId: o.originRefId }, after: null, decision: 'AMBIGUOUS', reason: `SOURCE_${o.reason}` });
  }
  await rapporter(ctx, counts, { step, accountId: null, entityType: 'summary', entityId: step,
    before: null, after: { scanned: r.scanned, fileLinksCreated: r.fileLinksCreated, sourceTracesCreated: r.sourceTracesCreated },
    decision: r.fileLinksCreated + r.sourceTracesCreated > 0 ? 'APPLIED' : 'NO_CHANGE', reason: 'AGENDA_SOURCE_LINKS' });
  return { step, scanned: r.scanned, counts, cursor: r.lastItemId, cards: 0, complete: true };
}

export async function runMig06(ctx: StepContext): Promise<StepResult> {
  const step = 'MIG-06' as const;
  const ignoree = ignoreeParCompte(step, ctx);
  if (ignoree) return ignoree;
  const counts = emptyCounts();
  const cur = curseurs(ctx);
  const r = await dedupeAutomaticAgendaItems(ctx.sql, {
    apply: ctx.apply, fromAccountId: ctx.fromCursor,
    onProgress: ({ accountId, groups }) => { ctx.log(`${step} : compte ${accountId}, ${groups} groupe(s)`); cur.noter(accountId); },
  });
  await cur.fin();
  for (const g of r.groups) {
    for (const id of g.remove) {
      await rapporter(ctx, counts, { step, accountId: g.accountId, assetId: g.assetId, entityType: 'agenda_item', entityId: id,
        before: { date: g.date, originFieldKey: g.originFieldKey, keep: g.keep }, after: { removed: true },
        decision: 'APPLIED', reason: 'AUTOMATIC_DUPLICATE' });
    }
    for (const id of g.protected) {
      await rapporter(ctx, counts, { step, accountId: g.accountId, assetId: g.assetId, entityType: 'agenda_item', entityId: id,
        before: { date: g.date, originFieldKey: g.originFieldKey }, after: null, decision: 'SKIPPED_USER', reason: 'MANUAL_OR_USER_MODIFIED' });
    }
  }
  return { step, scanned: r.itemsScanned, counts, cursor: r.lastAccountId, cards: 0, complete: true };
}

/** Estimation en lecture seule des liens colonnes manquants (dry-run MIG-08). */
export const MIG08_ESTIMATE_SQL = `
  SELECT count(*)::int AS n FROM asset_files f
   WHERE f.deleted_at IS NULL AND f.account_id IS NOT NULL
     AND ((f.asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_asset_links l
            WHERE l.file_id = f.id AND l.asset_id = f.asset_id AND l.status = 'ACTIVE'))
       OR (f.linked_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_asset_links l
            WHERE l.file_id = f.id AND l.asset_id = f.linked_asset_id AND l.status = 'ACTIVE'))
       OR (f.linked_room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_asset_links l
            WHERE l.file_id = f.id AND l.room_id = f.linked_room_id AND l.status = 'ACTIVE')))`;

export async function runMig08(ctx: StepContext): Promise<StepResult> {
  const step = 'MIG-08' as const;
  const ignoree = ignoreeParCompte(step, ctx);
  if (ignoree) return ignoree;
  const counts = emptyCounts();
  if (!ctx.apply) {
    const [{ n }] = (await ctx.sql.unsafe(MIG08_ESTIMATE_SQL)) as unknown as Array<{ n: number }>;
    await rapporter(ctx, counts, { step, accountId: null, entityType: 'summary', entityId: step, before: null,
      after: { filesWithMissingColumnLinks: Number(n) }, decision: Number(n) > 0 ? 'APPLIED' : 'NO_CHANGE', reason: 'ESTIMATE_READ_ONLY',
      details: { note: 'backfillDocumentAssetLinks n’a pas de simulation : estimation en lecture seule' } });
    return { step, scanned: 0, counts, cursor: 0, cards: 0, complete: true };
  }
  const cur = curseurs(ctx);
  const r = await backfillDocumentAssetLinks(ctx.sql, {
    batchSize: ctx.batchSize, pauseMs: ctx.pauseMs, fromFileId: ctx.fromCursor,
    onProgress: ({ phase, cursor, done }) => { ctx.log(`${step} : ${phase} ${done}, curseur ${cursor}`); if (phase === 'columns') cur.noter(cursor); },
  });
  await cur.fin();
  for (const a of r.ambiguous) {
    await rapporter(ctx, counts, { step, accountId: null, entityType: 'asset_file', entityId: a.fileId, before: null, after: null,
      decision: 'AMBIGUOUS', reason: a.reason, details: { proposalId: a.proposalId ?? null, detail: a.detail } });
  }
  const crees = r.legacyLinksAfter - r.legacyLinksBefore + r.migrationLinksCreated;
  await rapporter(ctx, counts, { step, accountId: null, entityType: 'summary', entityId: step, before: { legacyLinks: r.legacyLinksBefore },
    after: { legacyLinks: r.legacyLinksAfter, migrationLinksCreated: r.migrationLinksCreated, filesScanned: r.filesScanned },
    decision: crees > 0 ? 'APPLIED' : 'NO_CHANGE', reason: 'DOCUMENT_ASSET_LINKS' });
  return { step, scanned: r.filesScanned, counts, cursor: r.lastFileId, cards: 0, complete: true };
}
