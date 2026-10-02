'use client';

/**
 * Mon compte — espace de stockage utilisé (CDC Back-Office V1 STO-002,
 * STO-003).
 *
 * Garde-fou secondaire : le nombre de documents reste le quota principal,
 * affiché dans le récapitulatif d'abonnement. Ici, consommation et plafond de
 * l'offre ; à 100 %, seuls les nouveaux dépôts sont bloqués. En cas d'échec
 * de chargement, rien n'est affiché comme s'il s'agissait d'une donnée.
 */
import { useCallback, useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { formatBytes } from '@/lib/admin/format';
import { CollapsibleCard } from '@/components/ui/collapsible-card';

interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  ratio: number;
  isFull: boolean;
}

export function StorageUsageCard() {
  const [data, setData] = useState<StorageUsage | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch('/api/account/storage', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as StorageUsage);
    } catch {
      setData(null);
      setError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!data && !error) return null;

  return (
    // Tiroir fermé par défaut, sur le modèle « Informations légales ».
    <CollapsibleCard
      icon={<HardDrive className="w-5 h-5" />}
      title="Espace de stockage"
      description="Espace utilisé par vos fichiers et plafond de votre offre."
    >
      {error || !data ? (
        <p className="text-sm text-[color:var(--text-muted)]">
          Impossible d’afficher votre espace de stockage pour le moment.{' '}
          <button type="button" className="underline" onClick={() => load()}>Réessayer</button>
        </p>
      ) : (
        <>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-sm text-[color:var(--text-muted)]">Utilisé</span>
            <span className="text-sm font-medium text-[color:var(--text-primary)]">
              {formatBytes(data.usedBytes)} sur {formatBytes(data.limitBytes)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--bg-subtle)]">
            <div
              className={`h-full rounded-full ${data.isFull ? 'bg-red-500' : 'bg-[color:var(--accent)]'}`}
              style={{ width: `${Math.min(data.ratio * 100, 100)}%` }}
            />
          </div>
          {data.isFull ? (
            <p className="mt-2 text-xs text-red-500">
              Votre espace est plein : vous ne pouvez plus déposer de nouveaux fichiers. Vous pouvez toujours consulter,
              exporter, transmettre ou supprimer vos documents existants.
            </p>
          ) : (
            <p className="mt-2 text-xs text-[color:var(--text-muted)]">
              Plafond de votre offre. Le nombre de documents reste la limite principale de votre abonnement.
            </p>
          )}
        </>
      )}
    </CollapsibleCard>
  );
}
