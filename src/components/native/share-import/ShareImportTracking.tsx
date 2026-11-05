'use client';

/**
 * Suivi d'un partage natif — lot 110A. Écran ouvert par « Importer et ouvrir
 * Verebona » (ou « Voir le suivi » de la carte d'état).
 *
 *   · un seul fichier, enregistré par le serveur : le DOCUMENT s'ouvre
 *     directement (tiroir de « Mes documents », analyse en cours affichée) ;
 *   · sinon : état fidèle de chaque fichier — « Importation en cours »,
 *     « En attente de connexion », « Document ajouté » (accusé serveur
 *     seulement), « Échec » avec la cause — mis à jour automatiquement.
 * Aucun formulaire, aucun bouton « Importer » : l'import est déjà lancé.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileCheck2, FileClock, FileX2 } from 'lucide-react';
import { drawerHref } from '@/lib/drawers';
import { SHARE_IMPORT_STATUS_LABELS, type ShareImportFileState } from '@/lib/mobile/share-import-policy';
import { acknowledgeShare, readNativeShareState, type NativeShareFile } from '@/lib/native/share-import';

type ServerState =
  | { operationId: string; state: 'not_received' | 'deleted' }
  | { operationId: string; state: 'receiving'; fileId: number }
  | { operationId: string; state: 'imported'; fileId: number; title: string | null; processingStatus: string | null };

export interface TrackedFile {
  operationId: string;
  name: string;
  state: ShareImportFileState;
  message: string | null;
  fileId: number | null;
}

/**
 * Fusion état local (téléphone) + état serveur (pure, testée) : seul
 * l'accusé serveur vaut « Document ajouté » ; un document reçu mais pas
 * encore confirmé reste « Importation en cours ».
 */
export function mergeTracking(ops: readonly string[], server: readonly ServerState[], local: readonly NativeShareFile[]): TrackedFile[] {
  const ids = ops.length > 0 ? ops : local.map((f) => f.operationId);
  return ids.map((operationId, i) => {
    const s = server.find((x) => x.operationId === operationId);
    const l = local.find((x) => x.operationId === operationId);
    const name = l?.name ?? (s?.state === 'imported' ? s.title : null) ?? `Document ${i + 1}`;
    if (s?.state === 'imported') return { operationId, name, state: 'imported', message: null, fileId: s.fileId };
    // Accusé serveur déjà reçu par le téléphone (réponse de la route d'import).
    if (l?.state === 'imported' && l.fileId && s?.state !== 'deleted') return { operationId, name, state: 'imported', message: null, fileId: l.fileId };
    if (s?.state === 'deleted') return { operationId, name, state: 'failed', message: 'Document supprimé depuis.', fileId: null };
    if (l?.state === 'failed') return { operationId, name, state: 'failed', message: l.message ?? null, fileId: null };
    if (l?.state === 'waiting_auth' || l?.state === 'waiting_network') return { operationId, name, state: l.state, message: l.message ?? null, fileId: null };
    return { operationId, name, state: 'uploading', message: null, fileId: null };
  });
}

const POLL_MS = 3000;
const POLL_MAX = 60;

export function ShareImportTracking() {
  const router = useRouter();
  const params = useSearchParams();
  const shareId = params.get('partage');
  const ops = useMemo(() => (params.get('ops') ?? '').split(',').filter((o) => /^[A-Za-z0-9_-]{16,64}$/.test(o)).slice(0, 50), [params]);
  const [server, setServer] = useState<ServerState[]>([]);
  const [local, setLocal] = useState<NativeShareFile[]>([]);
  const polls = useRef(0);
  const opened = useRef(false);

  const tick = useCallback(async () => {
    const st = await readNativeShareState();
    const item = shareId ? st.items.find((i) => i.id === shareId) : undefined;
    const localFiles = item?.files ?? [];
    setLocal(localFiles);
    const wanted = ops.length > 0 ? ops : localFiles.map((f) => f.operationId);
    if (wanted.length === 0) return;
    try {
      const res = await fetch(`/api/mobile/share-import/status?ops=${wanted.join(',')}`, { credentials: 'include', cache: 'no-store' });
      if (res.ok) setServer(((await res.json()) as { items?: ServerState[] }).items ?? []);
    } catch { /* hors réseau : nouvel essai au prochain passage */ }
  }, [shareId, ops]);

  const files = mergeTracking(ops, server, local);
  const settled = files.length > 0 && files.every((f) => f.state === 'imported' || f.state === 'failed');

  useEffect(() => {
    void tick();
    const t = window.setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_MAX) { window.clearInterval(t); return; }
      void tick();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [tick]);

  // Un seul document enregistré : il s'ouvre directement.
  useEffect(() => {
    if (opened.current || files.length !== 1 || files[0].state !== 'imported' || !files[0].fileId) return;
    opened.current = true;
    if (shareId) void acknowledgeShare(shareId);
    router.replace(drawerHref({ kind: 'document', id: files[0].fileId }, '/documents'));
  }, [files, router, shareId]);

  // Partage terminé et affiché : copies locales purgées.
  useEffect(() => {
    if (settled && shareId && files.length > 1) void acknowledgeShare(shareId);
  }, [settled, shareId, files.length]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 p-4 md:p-6">
      <h1 className="vb-app-title">Import du partage</h1>
      {files.length === 0 ? (
        <p className="text-sm text-[color:var(--text-muted)]">Importation en cours…</p>
      ) : (
        <ul className="space-y-2">
          {files.map((f) => {
            const Icon = f.state === 'imported' ? FileCheck2 : f.state === 'failed' ? FileX2 : FileClock;
            return (
              <li key={f.operationId} className="flex items-start gap-3 rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-3">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">{f.name}</p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    {SHARE_IMPORT_STATUS_LABELS[f.state]}{f.message ? ` — ${f.message}` : ''}
                  </p>
                </div>
                {f.state === 'imported' && f.fileId && (
                  <Link className="shrink-0 text-sm font-medium text-[color:var(--accent)]" href={drawerHref({ kind: 'document', id: f.fileId }, '/documents')}>
                    Ouvrir
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-[color:var(--text-muted)]">
        Les informations du document (titre, bien, équipement…) sont complétées automatiquement puis restent modifiables.
      </p>
      <Link href="/documents" className="text-sm font-medium text-[color:var(--accent)]">Voir mes documents</Link>
    </div>
  );
}
