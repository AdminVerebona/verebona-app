'use client';

/**
 * Bandeau d'environnement et arrêt d'urgence — CDC BO IA VER-026, EST-01,
 * GST-01, SCR-01 (lot IA 2).
 *
 * · VER-026 : le bandeau PROD était présent sur le seul tableau de bord ; il
 *   est désormais affiché, non masquable, sur chaque page IA.
 * · GST-01 : l'état global est libellé « Opérationnel » / « Arrêt d'urgence ».
 * · EST-01 : l'arrêt d'urgence s'engage ICI, avec motif obligatoire, sans
 *   navigation secondaire (le tableau de bord renvoyait vers la File IA), et
 *   le relâchement demande une confirmation (il n'en demandait aucune).
 *
 * Source : `GET /api/admin/ai/queue` (état d'arrêt et environnement), lu au
 * montage et après chaque commande. `onChange` permet à la page hôte de se
 * recharger après un engagement ou un relâchement.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { OctagonX, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface StopState {
  active: boolean;
  reason: string | null;
  engagedAt: string | null;
}

/** Commande d'arrêt d'urgence, avec ses deux dialogues. */
export function EmergencyStopControl({
  stop, onChange,
}: { stop: StopState | null; onChange: () => void | Promise<void> }) {
  const [engaging, setEngaging] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (active: boolean) => {
    setBusy(true);
    try {
      await apiClient.post('/api/admin/ai/queue/emergency-stop', active ? { active, reason: reason.trim() } : { active });
      toast.success(active ? 'Arrêt d’urgence engagé' : 'Arrêt d’urgence relâché');
      setReason('');
      await onChange();
    } catch {
      toast.error(active ? 'L’arrêt d’urgence n’a pas pu être engagé.' : 'Le relâchement n’a pas abouti.');
    } finally {
      setBusy(false);
    }
  };

  if (!stop) return null;
  return (
    <>
      {stop.active ? (
        <Button size="sm" variant="outline" onClick={() => setReleasing(true)} disabled={busy}>
          <OctagonX className="w-3.5 h-3.5 mr-1.5 text-red-400" /> Relâcher l&apos;arrêt
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setEngaging(true)} disabled={busy}>
          <OctagonX className="w-3.5 h-3.5 mr-1.5" /> Arrêt d&apos;urgence
        </Button>
      )}

      <Dialog open={engaging} onOpenChange={setEngaging}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Engager l&apos;arrêt d&apos;urgence</DialogTitle>
            <DialogDescription>
              Tous les appels IA de l&apos;environnement sont refusés et les exécutions en cours sont
              interrompues puis remises en file. L&apos;assistant répond sans IA. Les états des
              traitements sont conservés et retrouvés au relâchement.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Motif (obligatoire)"
            maxLength={500}
            autoFocus
          />
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setEngaging(false)}>Revenir</Button>
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length === 0}
              onClick={() => { setEngaging(false); void send(true); }}
            >
              Engager
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={releasing} onOpenChange={setReleasing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Relâcher l&apos;arrêt d&apos;urgence</DialogTitle>
            <DialogDescription>
              Les appels IA reprennent immédiatement, et les files se vident selon l&apos;état de
              chaque traitement.{stop.reason ? ` Motif de l’arrêt : « ${stop.reason} ».` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setReleasing(false)}>Revenir</Button>
            <Button disabled={busy} onClick={() => { setReleasing(false); void send(false); }}>Relâcher</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Bandeau permanent des pages IA : environnement + état global + commande d'arrêt. */
export function AiEnvBanner({
  onChange, showControl = true,
}: {
  onChange?: () => void | Promise<void>;
  /** `false` sur la page File IA, qui porte déjà sa propre commande d'arrêt. */
  showControl?: boolean;
}) {
  const [environment, setEnvironment] = useState<string | null>(null);
  const [stop, setStop] = useState<StopState | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ environment?: string; emergencyStop: StopState }>('/api/admin/ai/queue');
      setEnvironment(r.environment ?? null);
      setStop(r.emergencyStop);
    } catch {
      /* bandeau informatif : la page hôte signale elle-même ses erreurs */
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!environment && !stop) return null;
  const prod = environment === 'production';
  return (
    <div
      role="status"
      className={`rounded-xl border px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm ${prod
        ? 'border-red-500/40 bg-red-500/5'
        : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]'}`}
    >
      <span className={`font-semibold ${prod ? 'text-red-400' : 'text-[color:var(--text-primary)]'}`}>
        {prod ? 'PRODUCTION' : `Environnement : ${environment ?? '—'}`}
      </span>
      <span className="flex items-center gap-1.5 flex-1 min-w-0">
        {stop?.active ? (
          <>
            <OctagonX className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-red-400 truncate">
              Arrêt d&apos;urgence{stop.reason ? ` — ${stop.reason}` : ''}
            </span>
          </>
        ) : (
          <>
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span className="text-[color:var(--text-secondary)]">Opérationnel</span>
          </>
        )}
      </span>
      {showControl && (
        <EmergencyStopControl
          stop={stop}
          onChange={async () => { await load(); await onChange?.(); }}
        />
      )}
    </div>
  );
}
