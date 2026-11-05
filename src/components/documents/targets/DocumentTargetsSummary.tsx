'use client';

/**
 * Lot 111I — affichage de TOUS les rattachements d'un document (biens,
 * pièces, équipements), en lecture : fiche document (web + mobile). Une
 * ligne par niveau, chaque cible ouvrable ; une cible déduite (bien d'un
 * équipement, pièce d'un équipement) est signalée « par l’équipement … » / « par la pièce … ». Charte
 * Sérénité : jetons seulement.
 */
import type { ReactNode } from 'react';
import { Building2, LayoutGrid, Wrench } from 'lucide-react';
import { impliedLabel } from '@/lib/documents/document-targets-selection';

export interface DocumentTargetItemDto {
  id: number;
  name: string;
  assetId: number;
  roomId?: number | null;
  provenance: 'USER' | 'AI' | 'HISTORY';
  principal: boolean;
  implied: boolean;
  via?: { kind: 'room' | 'equipment'; id: number; name: string } | null;
}

export interface DocumentTargetsViewDto {
  assets: DocumentTargetItemDto[];
  rooms: DocumentTargetItemDto[];
  equipments: DocumentTargetItemDto[];
}

/** Libellé de provenance (accessibilité / info-bulle) — jamais de code technique. */
export function provenanceLabel(p: DocumentTargetItemDto['provenance']): string {
  return p === 'USER' ? 'Choisi par vous' : p === 'AI' ? 'Proposé par l’analyse automatique' : 'Rattachement existant';
}

interface Props {
  targets: DocumentTargetsViewDto;
  onOpenRoom?: (id: number) => void;
  onOpenEquipment?: (id: number) => void;
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">{icon}{label}</span>
      <span className="flex min-w-0 flex-wrap justify-end gap-x-2 gap-y-1 text-right text-xs">{children}</span>
    </div>
  );
}

export function DocumentTargetsSummary({ targets, onOpenRoom, onOpenEquipment }: Props) {
  const { assets, rooms, equipments } = targets;
  if (!assets.length && !rooms.length && !equipments.length) return null;
  const via = (t: DocumentTargetItemDto) => (t.implied && t.via ? <span className="text-muted-foreground"> ({impliedLabel(t.via.kind, t.via.name)})</span> : null);
  return (
    <>
      {assets.length > 0 && (
        <Row icon={<Building2 className="h-3.5 w-3.5" aria-hidden="true" />} label={assets.length > 1 ? 'Biens' : 'Bien'}>
          {assets.map((a) => (
            <span key={a.id}>
              <a href={`/assets/${a.id}`} className="font-medium text-primary hover:underline" title={provenanceLabel(a.provenance)}>{a.name || `Bien #${a.id}`}</a>
              {via(a)}
            </span>
          ))}
        </Row>
      )}
      {rooms.length > 0 && (
        <Row icon={<LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />} label={rooms.length > 1 ? 'Pièces' : 'Pièce'}>
          {rooms.map((r) => (
            <span key={r.id}>
              <button type="button" className="font-medium transition-colors hover:text-primary hover:underline" title={provenanceLabel(r.provenance)} onClick={() => onOpenRoom?.(r.id)}>
                {r.name || `Pièce #${r.id}`}
              </button>
              {via(r)}
            </span>
          ))}
        </Row>
      )}
      {equipments.length > 0 && (
        <Row icon={<Wrench className="h-3.5 w-3.5" aria-hidden="true" />} label={equipments.length > 1 ? 'Équipements' : 'Équipement'}>
          {equipments.map((e) => (
            <button key={e.id} type="button" className="font-medium transition-colors hover:text-primary hover:underline" title={provenanceLabel(e.provenance)} onClick={() => onOpenEquipment?.(e.id)}>
              {e.name || `Équipement #${e.id}`}
            </button>
          ))}
        </Row>
      )}
    </>
  );
}
