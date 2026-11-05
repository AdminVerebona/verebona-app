'use client';

/**
 * Carte d'état des imports du partage natif — lot 110A.
 *
 * Remplace, pour les partages natifs, la carte « Document partagé en attente
 * d'import » et ses boutons : le partage a DÉJÀ été validé dans l'interface native, il n'y
 * a plus rien à confirmer. La carte dit seulement, fidèlement, où en est
 * l'import : « Importation en cours », « En attente de connexion »,
 * « Document ajouté » (après accusé serveur), « Échec » avec la cause.
 * Fermée par l'utilisateur une fois l'import terminé (copies locales purgées).
 */
import { FileCheck2, FileClock, FileX2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SHARE_IMPORT_STATUS_LABELS } from '@/lib/mobile/share-import-policy';
import { isSettled, summarize, trackingPath, type NativeShareItem } from '@/lib/native/share-import';

/** Titre de la carte (pur, testé). */
export function shareCardTitle(items: readonly NativeShareItem[]): string {
  const s = summarize(items);
  const total = s.inProgress + s.waiting + s.imported + s.failed;
  if (s.inProgress > 0) return total > 1 ? `Importation en cours (${total} documents)` : 'Importation en cours';
  if (s.waiting > 0) return 'Import en attente de connexion';
  if (s.failed > 0 && s.imported === 0) return s.failed > 1 ? `Échec de l’import de ${s.failed} documents` : 'Échec de l’import';
  if (s.failed > 0) return `${s.imported} ajouté${s.imported > 1 ? 's' : ''}, ${s.failed} en échec`;
  return s.imported > 1 ? `${s.imported} documents ajoutés à Verebona` : 'Document ajouté à Verebona';
}

export function ShareImportStatusCard({ items, onOpen, onClose }: {
  items: NativeShareItem[];
  onOpen: (path: string) => void;
  onClose: (id: string) => void;
}) {
  if (items.length === 0) return null;
  const files = items.flatMap((i) => i.files.map((f) => ({ ...f, share: i.id })));
  const settled = items.every(isSettled);
  const s = summarize(items);
  const Icon = s.failed > 0 && settled ? FileX2 : settled ? FileCheck2 : FileClock;
  const last = items[items.length - 1];
  return (
    <div
      role="status"
      aria-live="polite"
      aria-labelledby="vb-share-import-title"
      className="fixed inset-x-3 z-[997] rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 shadow-lg md:left-auto md:right-6 md:w-96"
      style={{ bottom: 'max(1rem, calc(var(--vb-safe-bottom) + 4.5rem))' }}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p id="vb-share-import-title" className="text-sm font-medium">{shareCardTitle(items)}</p>
          <ul className="space-y-1">
            {files.slice(0, 4).map((f) => (
              <li key={f.operationId} className="text-xs text-muted-foreground">
                <span className="block truncate font-medium text-[color:var(--text-primary)]">{f.name}</span>
                <span>{SHARE_IMPORT_STATUS_LABELS[f.state]}{f.state === 'failed' && f.message ? ` — ${f.message}` : ''}{f.state === 'waiting_auth' && f.message ? ` — ${f.message}` : ''}</span>
              </li>
            ))}
            {files.length > 4 && <li className="text-xs text-muted-foreground">et {files.length - 4} autre{files.length - 4 > 1 ? 's' : ''}</li>}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onOpen(trackingPath(last))}>Voir le suivi</Button>
            {settled && (
              <Button size="sm" variant="ghost" onClick={() => { for (const i of items) onClose(i.id); }}>Fermer</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
