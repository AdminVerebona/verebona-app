"use client";

/**
 * Contrôles de liste du back-office : pagination classique (GEN-004, SUB-008,
 * REF-003) et en-tête de colonne triable (SUB-007, REF-002, REFD-002).
 */
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';

export function AdminPagination({
  page, totalPages, total, onPage, disabled,
}: { page: number; totalPages: number; total: number; onPage: (page: number) => void; disabled?: boolean }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>{total} élément{total > 1 ? 's' : ''} — page {page} / {totalPages}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Précédente
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || page >= totalPages} onClick={() => onPage(page + 1)}>
          Suivante <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function SortHeader<K extends string>({
  label, sortKey, current, dir, onSort, align = 'left',
}: {
  label: string;
  sortKey: K;
  current: K;
  dir: 'asc' | 'desc';
  onSort: (key: K) => void;
  align?: 'left' | 'right';
}) {
  const active = current === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      title={active ? (dir === 'asc' ? 'Tri croissant' : 'Tri décroissant') : 'Trier'}
      className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${active ? 'text-foreground' : ''} ${align === 'right' ? 'justify-end w-full' : ''}`}
    >
      {label}
      <Icon className="h-3 w-3" />
    </button>
  );
}

/** Tri suivant : même colonne → inverse le sens ; autre colonne → croissant. */
export function nextSort<K extends string>(current: K, dir: 'asc' | 'desc', key: K): { sort: K; dir: 'asc' | 'desc' } {
  return current === key ? { sort: key, dir: dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: 'asc' };
}
