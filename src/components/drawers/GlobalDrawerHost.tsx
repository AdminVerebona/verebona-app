'use client';

/**
 * Hôte des tiroirs généralisés — voir `src/lib/drawers.ts`.
 *
 * Monté une fois dans DashboardLayout. Il ouvre échéance, équipement et pièce
 * à partir d'un simple identifiant : la fiche est chargée ici, l'écran appelant
 * n'a rien à savoir de sa forme. Le document reste servi par le tiroir
 * historique du layout, que le lien profond déclenche aussi.
 */
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import {
  DRAWER_PARAM, OPEN_ENTITY_DRAWER, openDrawer, parseDrawerParam, type DrawerTarget,
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

type Opened =
  | { kind: 'echeance'; item: AgendaItemFull; initialMode: 'view' | 'edit' }
  | { kind: 'equipement'; assetId: number; assetName: string; equipment: EquipmentDrawerItem }
  | { kind: 'piece'; assetId: number; room: RoomDrawerItem };

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
  const [opened, setOpened] = useState<Opened | null>(null);

  const open = useCallback(async (t: DrawerTarget) => {
    try {
      if (t.kind === 'echeance') {
        const { item } = await apiClient.get<{ item: AgendaItemFull }>(`/api/agenda/${t.id}`);
        setOpened({ kind: 'echeance', item, initialMode: t.initialMode ?? 'view' });
      } else if (t.kind === 'equipement') {
        const { equipment } = await apiClient.get<{
          equipment: EquipmentDrawerItem & { assetName: string };
        }>(`/api/equipments/${t.id}`);
        setOpened({ kind: 'equipement', assetId: equipment.assetId, assetName: equipment.assetName, equipment });
      } else if (t.kind === 'piece') {
        const { room } = await apiClient.get<{ room: RoomDrawerItem & { assetId: number } }>(`/api/substructures/${t.id}`);
        setOpened({ kind: 'piece', assetId: room.assetId, room });
      }
    } catch {
      if (t.kind !== 'document') toast.error(MESSAGES[t.kind]);
    }
  }, []);

  // Ouverture depuis le code : openDrawer({ kind, id }).
  useEffect(() => {
    const handler = (e: Event) => {
      const t = (e as CustomEvent<DrawerTarget>).detail;
      if (t && t.kind !== 'document') void open(t);
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

  const close = () => setOpened(null);

  if (!opened) return null;

  if (opened.kind === 'echeance') {
    return (
      <AgendaItemDrawer
        item={opened.item}
        open
        initialMode={opened.initialMode}
        onClose={close}
        onMutated={() => { close(); signalMutation(true); }}
        onOpenDocument={(fileId) => { close(); openDrawer({ kind: 'document', id: fileId }); }}
      />
    );
  }

  if (opened.kind === 'equipement') {
    return (
      <EquipmentDrawer
        open
        onOpenChange={(v) => { if (!v) close(); }}
        assetId={opened.assetId}
        assetName={opened.assetName}
        equipment={opened.equipment}
        substructures={[]}
        onRefresh={() => signalMutation()}
      />
    );
  }

  return (
    <RoomDrawer
      open
      onOpenChange={(v) => { if (!v) close(); }}
      assetId={opened.assetId}
      room={opened.room}
      onRefresh={() => signalMutation()}
    />
  );
}
