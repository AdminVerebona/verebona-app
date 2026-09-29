"use client"

/**
 * Liste structurée des informations complémentaires (lignes répétables) —
 * dommages, actions et échanges du sinistre, points forts de vente,
 * protections et éléments à assurer, charges et taxes.
 *
 * Composant contrôlé : la ligne vit dans l'état du parent
 * (`AssetAdditionalInfosSection`), qui décide de l'envoi (liste entière,
 * brouillons retirés, validation identique au serveur — `listFormState`).
 * Ici : saisie des cellules, ajout, retrait, réordonnancement, et affichage
 * des erreurs par cellule. Les montants se saisissent en euros (texte local
 * tant que la saisie n'est pas lisible).
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  LIST_REFS_MAX, formatCentsForInput, interpretListCellInput, newListItemId,
  type AdditionalInfoFieldDef, type AdditionalInfoReferencesDto, type ListCellValue, type ListColumnDef, type ListItem,
} from '@/lib/assets/additional-infos';
import { AdditionalInfosRefPicker } from './AdditionalInfosRefPicker';

const NONE = '__none__';

interface Props {
  def: AdditionalInfoFieldDef;
  items: ListItem[];
  onChange: (items: ListItem[], opts?: { localError?: boolean }) => void;
  rowErrors: Record<string, Record<string, string>>;
  listError: string | null;
  references: AdditionalInfoReferencesDto | null;
  readOnly?: boolean;
  /** Préfixe des identifiants de champs (unicité dans la page). */
  idPrefix: string;
  /** Contenu ajouté sous la liste (suggestions de points forts). */
  footer?: React.ReactNode;
  /** Mode compact (tiroir de préparation) : une colonne. */
  compact?: boolean;
}

const spanClass = (span: number | undefined, compact: boolean) =>
  compact ? '' : span === 3 ? 'sm:col-span-3' : span === 2 ? 'sm:col-span-2' : '';

const frDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');

export function AdditionalInfosListField({
  def, items, onChange, rowErrors, listError, references, readOnly = false, idPrefix, footer, compact = false,
}: Props) {
  const list = def.list!;
  /** Saisie en cours illisible (montant « 12,,5 »…), par `ligne.colonne`. */
  const [drafts, setDrafts] = useState<Record<string, { raw: string; error: string }>>({});
  const columns = list.columns.filter((c) => !c.hidden);
  const full = items.length >= list.maxItems;

  const emit = (next: ListItem[], nextDrafts = drafts) => onChange(next, { localError: Object.values(nextDrafts).some((d) => !!d.error) });

  const setCell = (rowId: string, col: ListColumnDef, value: ListCellValue | undefined) => {
    const next = items.map((it) => {
      if (it.id !== rowId) return it;
      const copy: ListItem = { ...it };
      if (value === undefined) delete copy[col.key];
      else copy[col.key] = value;
      return copy;
    });
    const k = `${rowId}.${col.key}`;
    let nextDrafts = drafts;
    if (k in drafts) {
      nextDrafts = { ...drafts };
      delete nextDrafts[k];
      setDrafts(nextDrafts);
    }
    emit(next, nextDrafts);
  };

  const onText = (rowId: string, col: ListColumnDef, raw: string) => {
    const r = interpretListCellInput(col, raw);
    const k = `${rowId}.${col.key}`;
    if (r.kind === 'invalid') {
      const nextDrafts = { ...drafts, [k]: { raw, error: r.message } };
      setDrafts(nextDrafts);
      emit(items, nextDrafts);
      return;
    }
    if (col.type === 'money' || col.type === 'year') {
      // Saisie lisible : texte gardé tel quel jusqu'à la sortie du champ.
      const nextDrafts = { ...drafts };
      delete nextDrafts[k];
      setDrafts({ ...nextDrafts, [k]: { raw, error: '' } });
      const next = items.map((it) => {
        if (it.id !== rowId) return it;
        const copy: ListItem = { ...it };
        if (r.kind === 'clear') delete copy[col.key]; else copy[col.key] = r.value;
        return copy;
      });
      emit(next, nextDrafts);
      return;
    }
    setCell(rowId, col, r.kind === 'clear' ? undefined : r.value);
  };

  /** Sortie d'un montant : remis en forme française (ou laissé tel quel s'il est invalide). */
  const onBlurCell = (rowId: string, col: ListColumnDef) => {
    const k = `${rowId}.${col.key}`;
    if (drafts[k] && !drafts[k].error) {
      const nextDrafts = { ...drafts };
      delete nextDrafts[k];
      setDrafts(nextDrafts);
    }
  };

  const add = () => {
    if (full) return;
    emit([...items, { id: newListItemId() }]);
  };
  const remove = (rowId: string) => {
    const nextDrafts = Object.fromEntries(Object.entries(drafts).filter(([k]) => !k.startsWith(`${rowId}.`)));
    setDrafts(nextDrafts);
    emit(items.filter((it) => it.id !== rowId), nextDrafts);
  };
  const move = (index: number, delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[index], next[j]] = [next[j], next[index]];
    emit(next);
  };

  const cellInput = (row: ListItem, col: ListColumnDef, inputId: string, error: string | undefined) => {
    const k = `${row.id}.${col.key}`;
    const value = row[col.key];
    switch (col.type) {
      case 'textarea':
        return (
          <Textarea id={inputId} rows={2} value={typeof value === 'string' ? value : ''} placeholder={col.placeholder}
            aria-invalid={!!error} readOnly={readOnly} className="text-sm min-h-[60px]"
            onChange={(e) => onText(row.id, col, e.target.value)} />
        );
      case 'enum':
        return (
          <Select value={typeof value === 'string' ? value : NONE} disabled={readOnly}
            onValueChange={(v) => setCell(row.id, col, v === NONE ? undefined : v)}>
            <SelectTrigger id={inputId} className="w-full text-sm" aria-invalid={!!error}><SelectValue placeholder="Non renseigné" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Non renseigné</SelectItem>
              {(col.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        );
      case 'documentRef': {
        const docs = (references?.documents ?? []).filter((d) => !d.occupantData);
        const current = typeof value === 'number' ? value : null;
        const known = current == null || docs.some((d) => d.id === current);
        return (
          <Select value={current != null ? String(current) : NONE} disabled={readOnly || !references}
            onValueChange={(v) => setCell(row.id, col, v === NONE ? undefined : Number(v))}>
            <SelectTrigger id={inputId} className="w-full text-sm" aria-invalid={!!error}>
              <SelectValue placeholder={references ? 'Aucune pièce' : 'Chargement…'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Aucune pièce</SelectItem>
              {!known && <SelectItem value={String(current)}>Pièce supprimée du bien</SelectItem>}
              {docs.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.title}{d.date ? ` · ${frDate(d.date)}` : ''}{d.sensitive ? ' · sensible' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      case 'documentRefs':
      case 'photoRefs':
        return (
          <AdditionalInfosRefPicker
            id={inputId}
            kind={col.type === 'photoRefs' ? 'photos' : 'documents'}
            value={Array.isArray(value) ? value : []}
            onChange={(ids) => setCell(row.id, col, ids.length ? ids : undefined)}
            documents={references?.documents ?? []}
            photos={references?.photos ?? []}
            max={col.max ?? LIST_REFS_MAX}
            disabled={readOnly || !references}
            label={col.label}
            invalid={!!error}
          />
        );
      default: {
        const draft = drafts[k];
        const shown = draft ? draft.raw
          : col.type === 'money' ? (typeof value === 'number' ? formatCentsForInput(value) : '')
            : value === undefined ? '' : String(value);
        return (
          <div className="relative">
            <Input
              id={inputId}
              type={col.type === 'date' ? 'date' : 'text'}
              inputMode={col.type === 'money' ? 'decimal' : col.type === 'year' ? 'numeric' : undefined}
              value={shown}
              placeholder={col.placeholder ?? (col.type === 'money' ? '0' : undefined)}
              aria-invalid={!!error}
              readOnly={readOnly}
              maxLength={col.type === 'text' ? (col.max ?? 200) + 20 : undefined}
              className={`text-sm ${col.type === 'money' ? 'pr-8' : ''}`}
              onChange={(e) => onText(row.id, col, e.target.value)}
              onBlur={() => onBlurCell(row.id, col)}
            />
            {col.type === 'money' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">€</span>}
          </div>
        );
      }
    }
  };

  return (
    <div className="space-y-2.5" data-list-field={`${def.section}.${def.key}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">
          {def.label}
          {def.recommended && <span className="ml-1.5 text-[10px] font-semibold text-primary/80">Recommandé</span>}
        </p>
        <span className="text-[11px] text-muted-foreground tabular-nums">{items.length} / {list.maxItems}</span>
      </div>
      {def.help && <p className="text-[11px] text-muted-foreground/80 leading-snug -mt-1.5">{def.help}</p>}

      {items.length === 0 && list.emptyHint && (
        <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground leading-snug">{list.emptyHint}</p>
      )}

      <ol className="space-y-2">
        {items.map((row, index) => {
          const errs = rowErrors[row.id] ?? {};
          return (
            <li key={row.id} className="rounded-lg border border-border bg-muted/20 p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{list.itemLabel} {index + 1}</span>
                {!readOnly && (
                  <div className="flex items-center gap-0.5">
                    <button type="button" onClick={() => move(index, -1)} disabled={index === 0}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30"
                      aria-label={`Monter ${list.itemLabel.toLowerCase()} ${index + 1}`}><ArrowUp className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-30"
                      aria-label={`Descendre ${list.itemLabel.toLowerCase()} ${index + 1}`}><ArrowDown className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => remove(row.id)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                      aria-label={`Supprimer ${list.itemLabel.toLowerCase()} ${index + 1}`}><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                )}
              </div>
              <div className={`grid grid-cols-1 gap-3 ${compact ? '' : 'sm:grid-cols-3'}`}>
                {columns.map((col) => {
                  const inputId = `${idPrefix}-${row.id}-${col.key}`;
                  const error = drafts[`${row.id}.${col.key}`]?.error || errs[col.key];
                  return (
                    <div key={col.key} className={`space-y-1 min-w-0 ${spanClass(col.span, compact)}`}>
                      <Label htmlFor={inputId} className="text-[11px] text-muted-foreground font-medium">
                        {col.label}{col.required && <span className="text-primary/80" aria-hidden> *</span>}
                      </Label>
                      {cellInput(row, col, inputId, error)}
                      {error ? <p className="text-[11px] text-red-400">{error}</p>
                        : col.help ? <p className="text-[11px] text-muted-foreground/80 leading-snug">{col.help}</p> : null}
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>

      {listError && <p className="text-[11px] text-red-400">{listError}</p>}

      {!readOnly && (
        <button type="button" onClick={add} disabled={full}
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/60 disabled:opacity-40 disabled:pointer-events-none">
          <Plus className="w-3.5 h-3.5" />{full ? `${list.maxItems} au plus` : list.addLabel}
        </button>
      )}
      {footer}
    </div>
  );
}
