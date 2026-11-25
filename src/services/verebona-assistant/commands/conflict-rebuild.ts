/**
 * Carte #843 (E07) — RECONSTRUCTION, après un CONFLIT DE VERSION, des actions des « anciennes voies » (renommer ou
 * retirer un équipement, renommer ou supprimer une pièce, archiver un fournisseur, modifier ou supprimer un
 * document, supprimer une échéance, opérations et leurs liens).
 *
 * Avant #843, seules les modifications à plusieurs champs (#807 : équipement, fournisseur, échéance) étaient
 * reproposées ; les autres disaient « refaites votre demande ». Désormais : la cible est RELUE dans le compte,
 * l'action est refaite sur l'état ACTUEL (nouvel avant / après, nouvelles versions attendues) et présentée dans un
 * NOUVEAU plan, qui ne s'exécute qu'après une NOUVELLE confirmation (`plan.service.replanAfterConflict`).
 *
 * `null` : rien à reproposer (cible disparue, plus rien à changer, commande non reconstructible) — l'issue du plan
 * dit alors « rien n'a été fait, refaites votre demande ». Lecture seule ; n'écrit rien.
 */
import { formatDateFr } from '../core/deterministic-format';
import type { CommandParams, PlannedAction } from './catalog';
import type { CommandLookup } from './plan.service';

/** Ligne ajoutée aux conséquences d'une action reproposée (texte à valider par le PO). */
export const REBUILT_AFTER_CONFLICT_EFFECT = 'Données relues après une modification faite entre-temps : vérifiez cet aperçu avant de confirmer.';

const avecRelu = (a: PlannedAction): PlannedAction => ({ ...a, effects: [...a.effects.filter((e) => e !== REBUILT_AFTER_CONFLICT_EFFECT), REBUILT_AFTER_CONFLICT_EFFECT] });

type P<K extends string> = Extract<CommandParams, { kind: K }>;

export async function rebuildLegacyAfterConflict(action: PlannedAction, accountId: number, lookup: CommandLookup): Promise<PlannedAction | null> {
  const p = action.params as CommandParams & { kind?: string };
  switch (p.kind) {
    case 'equipment_rename': {
      const q = p as P<'equipment_rename'>;
      const e = await lookup.getEquipmentState?.(accountId, q.equipmentId);
      if (!e || e.name === q.equipmentName) return null;
      return avecRelu({
        ...action, targets: [{ type: 'equipment', id: e.id, label: e.name }],
        params: { ...q, equipmentAssetId: e.assetId, expectedVersion: e.version },
        preview: `Renommer l’équipement « ${e.name} » (${e.assetName}) en « ${q.equipmentName} ».`,
        effects: [`Équipement : ${e.name} → ${q.equipmentName}`, `Bien : ${e.assetName}`],
      });
    }
    case 'equipment_archive': {
      const q = p as P<'equipment_archive'>;
      const e = await lookup.getEquipmentState?.(accountId, q.equipmentId);
      if (!e) return null;
      return avecRelu({
        ...action, targets: [{ type: 'equipment', id: e.id, label: e.name }],
        params: { ...q, equipmentAssetId: e.assetId, expectedVersion: e.version },
        preview: `Retirer l’équipement « ${e.name} » de ${e.assetName}.`,
        effects: ['L’équipement est archivé : il n’apparaît plus dans le bien, rien n’est supprimé.',
          `Conservés : ${e.documents} document(s), ${e.agenda} échéance(s).`],
      });
    }
    case 'room_rename': {
      const q = p as P<'room_rename'>;
      const r = await lookup.getRoomState?.(accountId, q.roomId);
      if (!r || r.name === q.roomName) return null;
      return avecRelu({
        ...action, targets: [{ type: 'room', id: r.id, label: r.name }],
        params: { ...q, roomAssetId: r.assetId, expectedVersion: r.version },
        preview: `Renommer la pièce « ${r.name} » (${r.assetName}) en « ${q.roomName} ».`,
        effects: [`Pièce : ${r.name} → ${q.roomName}`, `Bien : ${r.assetName}`],
      });
    }
    case 'room_delete': {
      const q = p as P<'room_delete'>;
      const r = await lookup.getRoomState?.(accountId, q.roomId);
      if (!r) return null;
      return avecRelu({
        ...action, targets: [{ type: 'room', id: r.id, label: r.name }],
        params: { ...q, roomAssetId: r.assetId, expectedVersion: r.version },
        preview: `Supprimer la pièce « ${r.name} » de ${r.assetName}.`,
        effects: [`Conservés dans ${r.assetName}, sans pièce : ${r.documents} document(s), ${r.equipments} équipement(s).`, 'Cette action est irréversible.'],
      });
    }
    case 'supplier_archive': {
      const q = p as P<'supplier_archive'>;
      const f = await lookup.getSupplierState?.(accountId, q.supplierId);
      if (!f || f.status === 'archived') return null;
      return avecRelu({
        ...action, targets: [{ type: 'supplier', id: f.id, label: f.name }],
        params: { ...q, expectedVersion: f.version },
        preview: `Archiver le fournisseur « ${f.name} ».`,
        effects: ['La fiche est archivée : rien n’est supprimé, elle se réactive depuis les fournisseurs.'],
      });
    }
    case 'document_update': {
      const q = p as P<'document_update'>;
      const d = await lookup.getDocumentState?.(accountId, q.documentId);
      if (!d) return null;
      const actuelle = q.documentField === 'title' ? d.title : q.documentField === 'date' ? d.documentDate : d.notesShown || null;
      if ((actuelle ?? null) === (q.newValue ?? null)) return null;
      const montrer = (v: string | null) => (v === null || v === '' ? '(vide)' : q.documentField === 'date' ? formatDateFr(v) : v);
      return avecRelu({
        ...action, targets: [{ type: 'document', id: d.id, label: d.title }],
        params: { ...q, expectedVersion: d.version },
        preview: `Modifier le document « ${d.title} » : ${montrer(actuelle)} → ${montrer(q.newValue)}.`,
        effects: [`Valeur actuelle : ${montrer(actuelle)}`, `Nouvelle valeur : ${montrer(q.newValue)}`],
      });
    }
    case 'document_delete': {
      const q = p as P<'document_delete'>;
      const d = await lookup.getDocumentState?.(accountId, q.documentId);
      if (!d) return null;
      return avecRelu({ ...action, targets: [{ type: 'document', id: d.id, label: d.title }], params: { ...q, expectedVersion: d.version }, preview: `Supprimer le document « ${d.title} ».` });
    }
    case 'documents_delete': {
      const q = p as P<'documents_delete'>;
      const relus = [];
      for (const x of q.documents) {
        const d = await lookup.getDocumentState?.(accountId, x.documentId);
        if (!d) return null;
        relus.push({ documentId: d.id, expectedVersion: d.version, title: d.title });
      }
      return avecRelu({ ...action, params: { ...q, documents: relus }, preview: `Supprimer ${relus.length} documents : ${relus.map((d) => `« ${d.title} »`).join(', ')}.` });
    }
    case 'agenda_delete': {
      const q = p as P<'agenda_delete'>;
      const { readAgendaSnapshot, agendaVersion } = await import('./undo.service');
      const { pgClient } = await import('@/db');
      const it = await readAgendaSnapshot(pgClient, accountId, q.agendaItemId);
      if (!it) return null;
      return avecRelu({
        ...action, targets: [{ type: 'agenda_item', id: q.agendaItemId, label: it.title }],
        params: { ...q, expectedVersion: agendaVersion(it) },
        preview: q.scope === 'SERIES' ? `Supprimer toute la série « ${it.title} » : ${q.expectedCount} échéances.`
          : `Supprimer l’échéance « ${it.title} »${it.startDate ? ` du ${formatDateFr(it.startDate)}` : ''}.`,
      });
    }
    default:
      return rebuildReferenceEventAfterConflict(action, accountId, lookup);
  }
}

/**
 * Opérations et leurs liens : les versions attendues sont RELUES (opération, document, fournisseur, échéance) et
 * l'aperçu reprend l'intitulé actuel de l'opération. Une correction (W22) dont la valeur demandée est déjà en
 * place n'est pas reproposée.
 */
async function rebuildReferenceEventAfterConflict(action: PlannedAction, accountId: number, lookup: CommandLookup): Promise<PlannedAction | null> {
  const p = action.params as unknown as Record<string, unknown> & { kind?: string };
  if (!p.kind?.startsWith('reference_event') || !lookup.getReferenceEventState) return null;
  const lire = async (id: unknown) => (typeof id === 'number' && id > 0 ? lookup.getReferenceEventState!(accountId, id) : null);
  const params: Record<string, unknown> = { ...p };
  if (p.kind === 'reference_events_associate' || p.kind === 'reference_events_dissociate') {
    const a = await lire(p.fromOperationId);
    const b = await lire(p.toOperationId);
    if (!a || !b) return null;
    params.expectedVersions = [a.version, b.version];
  } else {
    const s = await lire(p.operationId);
    if (!s) return null;
    params.expectedVersion = s.version;
    if (p.kind === 'reference_event_update') {
      const change = p.change as { field: string; value: string };
      const actuelle = (s as unknown as Record<string, unknown>)[change.field === 'label' ? 'technicalLabel' : change.field === 'type' ? 'typeCode' : change.field];
      if (actuelle === change.value) return null;
      const lue = actuelle === null || actuelle === undefined || actuelle === '' ? '(aucune)'
        : /^\d{4}-\d{2}-\d{2}$/.test(String(actuelle)) ? formatDateFr(String(actuelle)) : String(actuelle);
      return avecRelu({ ...action, params: params as unknown as PlannedAction['params'], effects: [...action.effects, `Valeur actuelle relue : ${lue}`] });
    }
    if (typeof p.linkedDocumentId === 'number') {
      const d = await lookup.getDocumentState?.(accountId, p.linkedDocumentId);
      if (!d) return null;
      params.documentVersion = d.version;
    }
    if (typeof p.linkedSupplierId === 'number') {
      const f = await lookup.getSupplierState?.(accountId, p.linkedSupplierId);
      if (!f) return null;
      params.supplierVersion = f.version;
    }
    if (typeof p.agendaItemId === 'number' && p.kind === 'reference_event_agenda') {
      const { readAgendaSnapshot, agendaVersion } = await import('./undo.service');
      const { pgClient } = await import('@/db');
      const it = await readAgendaSnapshot(pgClient, accountId, p.agendaItemId);
      if (!it) return null;
      params.agendaItemVersion = agendaVersion(it);
    }
  }
  return avecRelu({ ...action, params: params as unknown as PlannedAction['params'] });
}
