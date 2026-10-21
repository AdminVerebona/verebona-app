'use client';

/**
 * Hôte des tiroirs généralisés — voir `src/lib/drawers.ts`.
 *
 * Monté une fois dans DashboardLayout. Il ouvre échéance, équipement et pièce
 * à partir d'un simple identifiant : la fiche est chargée ici, l'écran appelant
 * n'a rien à savoir de sa forme. Le document reste servi par le tiroir
 * historique du layout, que le lien profond déclenche aussi.
 *
 * Lot 75H : les fiches forment une PILE (voir `pushDrawerEntry`). Une carte
 * d'entité cliquée dans un tiroir ouvre la fiche au-dessus ; la fermer ramène
 * au tiroir d'origine. Le document y entre aussi quand il est demandé « empilé »
 * (`openDrawer(t, { stack: true })`).
 */
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import {
  DRAWER_PARAM, OPEN_ENTITY_DRAWER, closeDrawerEntry, drawerKey, openDrawer, parseDrawerParam,
  pushDrawerEntry, type DrawerTarget,
} from '@/lib/drawers';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import type { EquipmentDrawerItem } from '@/components/assets/EquipmentDrawer';
import type { RoomDrawerItem } from '@/components/assets/RoomDrawer';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then((m) => ({ default: m.AgendaItemDrawer })),
  { ssr: false },
);
const EquipmentDrawer = dynamic(
  () => import('@/components/assets/EquipmentDrawer').then((m) => ({ default: m.EquipmentDrawer })),
  { ssr: false },
);
const RoomDrawer = dynamic(
  () => import('@/components/assets/RoomDrawer').then((m) => ({ default: m.RoomDrawer })),
  { ssr: false },
);
const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then((m) => ({ default: m.DocumentDrawer })),
  { ssr: false },
);

type Opened = { key: string } & (
  | { kind: 'echeance'; item: AgendaItemFull; initialMode: 'view' | 'edit' }
  | { kind: 'equipement'; assetId: number; assetName: string; equipment: EquipmentDrawerItem }
  | { kind: 'piece'; assetId: number; room: RoomDrawerItem }
  | { kind: 'document'; id: number; showAnalysisResults: boolean }
);

const MESSAGES: Record<Exclude<DrawerTarget['kind'], 'document'>, string> = {
  echeance: 'Impossible d’ouvrir cette échéance : elle a peut-être été supprimée.',
  equipement: 'Impossible d’ouvrir cet équipement : il a peut-être été supprimé.',
  piece: 'Impossible d’ouvrir cette pièce : elle a peut-être été supprimée.',
};

/**
 * Les écrans ouverts dessous se rafraîchissent sur les événements métier
 * existants (voir DATA_MUTATION_EVENTS dans data-freshness).
 */
function signalMutation(agenda = false) {
  if (agenda) window.dispatchEvent(new CustomEvent('agenda-mutated'));
  window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
}

export function GlobalDrawerHost() {
  const pathname = usePathname();
  const [stack, setStack] = useState<Opened[]>([]);

  const push = useCallback((entry: Opened) => setStack((s) => pushDrawerEntry(s, entry)), []);

  const open = useCallback(async (t: DrawerTarget) => {
    const key = drawerKey(t);
    try {
      if (t.kind === 'document') {
        // Le tiroir document charge lui-même sa fiche à partir de l'identifiant.
        push({ key, kind: 'document', id: t.id, showAnalysisResults: !!t.showAnalysisResults });
      } else if (t.kind === 'echeance') {
        const { item } = await apiClient.get<{ item: AgendaItemFull }>(`/api/agenda/${t.id}`);
        push({ key, kind: 'echeance', item, initialMode: t.initialMode ?? 'view' });
      } else if (t.kind === 'equipement') {
        const { equipment } = await apiClient.get<{
          equipment: EquipmentDrawerItem & { assetName: string };
        }>(`/api/equipments/${t.id}`);
        push({ key, kind: 'equipement', assetId: equipment.assetId, assetName: equipment.assetName, equipment });
      } else if (t.kind === 'piece') {
        const { room } = await apiClient.get<{ room: RoomDrawerItem & { assetId: number } }>(`/api/substructures/${t.id}`);
        push({ key, kind: 'piece', assetId: room.assetId, room });
      }
    } catch {
      if (t.kind !== 'document') toast.error(MESSAGES[t.kind]);
    }
  }, [push]);

  // Ouverture depuis le code : openDrawer({ kind, id }) — et, pour un
  // document, openDrawer({ kind: 'document', id }, { stack: true }).
  useEffect(() => {
    const handler = (e: Event) => {
      const t = (e as CustomEvent<DrawerTarget>).detail;
      if (t) void open(t);
    };
    window.addEventListener(OPEN_ENTITY_DRAWER, handler);
    return () => window.removeEventListener(OPEN_ENTITY_DRAWER, handler);
  }, [open]);

  // Lien profond : ?tiroir=<kind>:<id>, lu à chaque changement de page. Lu sur
  // window.location plutôt que useSearchParams, qui imposerait une frontière
  // Suspense autour de tout le layout.
  useEffect(() => {
    const url = new URL(window.location.href);
    const target = parseDrawerParam(url.searchParams.get(DRAWER_PARAM));
    if (!url.searchParams.has(DRAWER_PARAM)) return;
    url.searchParams.delete(DRAWER_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (target) openDrawer(target);
  }, [pathname]);

  if (stack.length === 0) return null;

  // Rendu dans l'ordre de la pile : chaque tiroir est monté (et son portail
  // ajouté au document) après celui qu'il recouvre.
  return <>{stack.map((entry) => <StackedDrawer key={entry.key} entry={entry} onClose={() => setStack((s) => closeDrawerEntry(s, entry.key))} />)}</>;
}

function StackedDrawer({ entry, onClose }: { entry: Opened; onClose: () => void }) {
  const close = onClose;

  if (entry.kind === 'echeance') {
    return (
      <AgendaItemDrawer
        item={entry.item}
        open
        initialMode={entry.initialMode}
        onClose={close}
        onMutated={() => { close(); signalMutation(true); }}
        // Lot 75H : le document s'empile au-dessus de l'échéance (retour à
        // l'échéance en le fermant) au lieu de la remplacer.
        onOpenDocument={(fileId) => openDrawer({ kind: 'document', id: fileId }, { stack: true })}
      />
    );
  }

  if (entry.kind === 'equipement') {
    return (
      <EquipmentDrawer
        open
        onOpenChange={(v) => { if (!v) close(); }}
        assetId={entry.assetId}
        assetName={entry.assetName}
        equipment={entry.equipment}
        substructures={[]}
        onRefresh={() => signalMutation()}
      />
    );
  }

  if (entry.kind === 'document') {
    return (
      <DocumentDrawer
        open
        onOpenChange={(v) => { if (!v) close(); }}
        document={{
          id: entry.id, originalFilename: '', mimeType: '', documentType: 'AUTRE',
          documentDate: null, uploadedAt: null, assetId: 0,
        }}
        onRefresh={() => signalMutation()}
        showAnalysisResults={entry.showAnalysisResults}
      />
    );
  }

  return (
    <RoomDrawer
      open
      onOpenChange={(v) => { if (!v) close(); }}
      assetId={entry.assetId}
      room={entry.room}
      onRefresh={() => signalMutation()}
    />
  );
}
