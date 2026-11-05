'use client';

/**
 * Lot 111I — sélecteurs MULTIPLES du rattachement d'un document (Biens,
 * Pièces, Équipements) : puces retirables + liste à cocher filtrable,
 * groupée par bien. Utilisé par le tiroir « Modifier le document » et par
 * l'ajout de document (« Informations complémentaires »), web et mobile
 * (interface distante).
 *
 * Accessibilité : chaque niveau a un libellé relié (aria-labelledby), ses
 * puces sont une liste nommée, chaque puce a un bouton « Retirer … » ; la
 * liste s'ouvre par un bouton (aria-expanded), se filtre par un champ
 * nommé, chaque option est une case à cocher libellée, regroupée par bien
 * (role="group"). Échap ferme (Radix). Charte Sérénité : jetons seulement.
 */
import { useId, useMemo, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  impliedLabel, impliedTargets, indexGroups, matchesFilter, orderedGroups, removeAsset, removeRoom, toggleAsset, toggleEquipment, toggleRoom,
  type TargetOptionGroupView, type TargetsValue,
} from '@/lib/documents/document-targets-selection';

interface Props {
  groups: readonly TargetOptionGroupView[];
  value: TargetsValue;
  onChange: (v: TargetsValue) => void;
  disabled?: boolean;
  /** Biens non retirables (dépôt depuis la fiche d'un bien). */
  lockedAssetIds?: readonly number[];
  /** Masque les niveaux Pièce / Équipement quand aucun bien proposé n'en a. */
  hideEmptyLevels?: boolean;
}

interface Chip { key: string; label: string; hint?: string; onRemove?: () => void }

function Chips({ label, chips, emptyLabel }: { label: string; chips: Chip[]; emptyLabel: string }) {
  if (!chips.length) return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <li key={c.key} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
          <span className="truncate">{c.label}</span>
          {c.hint && <span className="truncate text-muted-foreground">· {c.hint}</span>}
          {c.onRemove && (
            <button
              type="button"
              onClick={c.onRemove}
              aria-label={`Retirer ${c.label}`}
              className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

interface LevelProps {
  title: string;
  /** « biens », « pièces », « équipements » (libellés accessibles). */
  plural: string;
  emptyLabel: string;
  chips: Chip[];
  disabled?: boolean;
  options: Array<{ group: string; groupId: number; items: Array<{ id: number; label: string; checked: boolean; disabled?: boolean; onToggle: () => void }> }>;
  summary: string;
  noneAvailable: string;
}

function Level({ title, plural, emptyLabel, chips, disabled, options, summary, noneAvailable }: LevelProps) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [filtre, setFiltre] = useState('');
  const visibles = options
    .map((g) => ({ ...g, items: g.items.filter((i) => matchesFilter(i.label, filtre) || matchesFilter(g.group, filtre)) }))
    .filter((g) => g.items.length > 0);
  const total = options.reduce((s, g) => s + g.items.length, 0);
  return (
    <div className="space-y-1.5" role="group" aria-labelledby={labelId}>
      <p id={labelId} className="text-sm font-medium text-foreground">{title}</p>
      <Chips label={`Sélection : ${title}`} chips={chips} emptyLabel={emptyLabel} />
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setFiltre(''); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled || total === 0}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`Choisir des ${plural}`}
            className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="truncate">{total === 0 ? noneAvailable : summary}</span>
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-2" align="start">
          <Input
            value={filtre}
            onChange={(e) => setFiltre(e.target.value)}
            placeholder="Filtrer…"
            aria-label={`Filtrer les ${plural}`}
            className="mb-2 h-9"
            autoFocus
          />
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {visibles.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Aucun résultat.</p>}
            {visibles.map((g) => (
              <div key={g.groupId} role="group" aria-label={g.group}>
                {options.length > 1 && <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{g.group}</p>}
                {g.items.map((i) => (
                  <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                    <Checkbox checked={i.checked} disabled={i.disabled} onCheckedChange={i.onToggle} aria-label={i.label} />
                    <span className="truncate">{i.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const compte = (n: number, un: string, plusieurs: string, aucun: string) => (n === 0 ? aucun : n === 1 ? `1 ${un}` : `${n} ${plusieurs}`);

export function DocumentTargetsPicker({ groups, value, onChange, disabled, lockedAssetIds = [], hideEmptyLevels = true }: Props) {
  const ix = useMemo(() => indexGroups(groups), [groups]);
  const imp = useMemo(() => impliedTargets(groups, value), [groups, value]);
  const ordre = useMemo(() => orderedGroups(groups, value), [groups, value]);
  const avecPieces = ordre.filter((g) => g.rooms.length > 0);
  const avecEquipements = ordre.filter((g) => g.equipments.some((e) => !e.archived || value.equipmentIds.includes(e.id)));

  const assetChips: Chip[] = [
    ...value.assetIds.map((id) => ({
      key: `a${id}`, label: ix.assetName.get(id) ?? `Bien ${id}`,
      onRemove: lockedAssetIds.includes(id) || disabled ? undefined : () => onChange(removeAsset(groups, value, id)),
    })),
    ...imp.assets.map((a) => ({
      key: `ai${a.id}`, label: ix.assetName.get(a.id) ?? `Bien ${a.id}`, hint: impliedLabel(a.viaKind, a.via),
      onRemove: disabled ? undefined : () => onChange(removeAsset(groups, value, a.id)),
    })),
  ];
  const roomChips: Chip[] = [
    ...value.roomIds.map((id) => ({
      key: `r${id}`, label: ix.room.get(id)?.name ?? `Pièce ${id}`,
      hint: groups.length > 1 ? ix.assetName.get(ix.room.get(id)?.assetId ?? 0) : undefined,
      onRemove: disabled ? undefined : () => onChange(removeRoom(groups, value, id)),
    })),
    ...imp.rooms.map((r) => ({
      key: `ri${r.id}`, label: ix.room.get(r.id)?.name ?? `Pièce ${r.id}`, hint: impliedLabel(r.viaKind, r.via),
      onRemove: disabled ? undefined : () => onChange(removeRoom(groups, value, r.id)),
    })),
  ];
  const equipChips: Chip[] = value.equipmentIds.map((id) => ({
    key: `e${id}`, label: ix.equipment.get(id)?.name ?? `Équipement ${id}`,
    hint: groups.length > 1 ? ix.assetName.get(ix.equipment.get(id)?.assetId ?? 0) : undefined,
    onRemove: disabled ? undefined : () => onChange(toggleEquipment(value, id)),
  }));

  const impliedRoom = new Set(imp.rooms.map((r) => r.id));
  return (
    <div className="space-y-3">
      <Level
        title="Biens" plural="biens" emptyLabel="Aucun bien" noneAvailable="Aucun bien disponible" chips={assetChips} disabled={disabled}
        summary={compte(value.assetIds.length + imp.assets.length, 'bien', 'biens', 'Choisir des biens')}
        options={[{
          group: 'Biens', groupId: 0,
          items: ordre.map((g) => ({
            id: g.asset.id, label: g.asset.name,
            checked: value.assetIds.includes(g.asset.id),
            // Bien verrouillé / archivé : déjà rattaché seulement (retrait possible), jamais un nouvel ajout.
            disabled: lockedAssetIds.includes(g.asset.id) || (!g.asset.writable && !value.assetIds.includes(g.asset.id)),
            onToggle: () => onChange(value.assetIds.includes(g.asset.id) ? removeAsset(groups, value, g.asset.id) : toggleAsset(value, g.asset.id)),
          })),
        }]}
      />
      {(!hideEmptyLevels || avecPieces.length > 0) && (
        <Level
          title="Pièces" plural="pièces" emptyLabel="Aucune pièce" noneAvailable="Aucune pièce disponible" chips={roomChips} disabled={disabled}
          summary={compte(value.roomIds.length + imp.rooms.length, 'pièce', 'pièces', 'Choisir des pièces')}
          options={avecPieces.map((g) => ({
            group: g.asset.name, groupId: g.asset.id,
            items: g.rooms.map((r) => ({
              id: r.id, label: r.name, checked: value.roomIds.includes(r.id) || impliedRoom.has(r.id),
              disabled: impliedRoom.has(r.id) || (!g.asset.writable && !value.roomIds.includes(r.id)),
              onToggle: () => onChange(value.roomIds.includes(r.id) ? removeRoom(groups, value, r.id) : toggleRoom(value, r.id)),
            })),
          }))}
        />
      )}
      {(!hideEmptyLevels || avecEquipements.length > 0) && (
        <Level
          title="Équipements" plural="équipements" emptyLabel="Aucun équipement" noneAvailable="Aucun équipement disponible" chips={equipChips} disabled={disabled}
          summary={compte(value.equipmentIds.length, 'équipement', 'équipements', 'Choisir des équipements')}
          options={avecEquipements.map((g) => ({
            group: g.asset.name, groupId: g.asset.id,
            items: g.equipments.filter((e) => !e.archived || value.equipmentIds.includes(e.id)).map((e) => ({
              id: e.id, label: e.name, checked: value.equipmentIds.includes(e.id),
              disabled: !g.asset.writable && !value.equipmentIds.includes(e.id),
              onToggle: () => onChange(toggleEquipment(value, e.id)),
            })),
          }))}
        />
      )}
    </div>
  );
}
