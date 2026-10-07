"use client";

/**
 * Liste des fichiers d'un dépôt et de leurs actions — APP-PERF-29.
 *
 * Affichée DANS la modale d'ajout uniquement (lot 31, L31-5) : le suivi
 * flottant « Envoi de documents » a été supprimé (voir
 * `@/lib/upload-queue-feedback`). Chaque fichier peut être annulé, repris (à
 * l'étape où il s'est arrêté) ou retiré.
 *
 * ⚠️ Aucune promesse d'envoi en arrière-plan : la continuité d'un transfert
 * quand le téléphone se verrouille ou que la PWA est suspendue n'est pas
 * démontrée. Le message mobile le dit, et la reprise est proposée au retour.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Check, X, RotateCcw, FileUp, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useFileDepot } from '@/hooks/useFileDepot';
import { fileDepot, estActif, type ElementDepot } from '@/lib/upload-queue';
import { envoisAReprendre } from '@/lib/upload-queue-feedback';
import { ACCEPT_DEPOT } from '@/lib/upload-limits';

export function libelleEtape(e: ElementDepot): string {
  switch (e.etape) {
    case 'attente': return 'En attente';
    case 'preparation': return `Préparation ${Math.round(e.progression * 100)} %`;
    case 'pret': return 'En attente de transfert';
    case 'transfert': return `Envoi ${Math.round(e.progression * 100)} %`;
    case 'confirmation': return 'Enregistrement…';
    case 'termine': return 'Ajouté';
    case 'annule': return 'Annulé';
    case 'interrompu': return 'Interrompu';
    case 'echec': return 'Échec';
  }
}

export const MESSAGE_MOBILE =
  'Sur téléphone, gardez l’application ouverte pendant l’envoi : s’il est interrompu ' +
  '(mise en veille, fermeture), vous pourrez le reprendre depuis « Ajouter un document ».';

interface PanelProps {
  elements: ElementDepot[];
  mobile?: boolean;
  onAnnuler: (operationId: string) => void;
  onReprendre: (operationId: string) => void;
  /** Absent : resélection impossible depuis cette vue. */
  onChoisirFichier?: (operationId: string) => void;
  onRetirer?: (operationId: string) => void;
}

/** Liste des fichiers d'un dépôt avec leurs actions (modale d'ajout). */
export function UploadQueuePanel({ elements, mobile, onAnnuler, onReprendre, onChoisirFichier, onRetirer }: PanelProps) {
  const actifs = elements.some(estActif);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5">
        {elements.map((e) => {
          const reprenableSansFichier = e.reprise === 'confirmation';
          const peutReprendre = (e.etape === 'echec' || e.etape === 'interrompu') && e.reprise !== null
            && (e.fichierDisponible || reprenableSansFichier);
          const doitChoisir = (e.etape === 'echec' || e.etape === 'interrompu') && e.reprise !== null && !peutReprendre;
          const enCours = estActif(e);
          return (
            <li key={e.operationId} className="flex flex-col gap-1 rounded-lg border border-[color:var(--border-subtle)] px-2.5 py-2">
              <div className="flex items-center gap-2 min-w-0">
                {enCours
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 text-[color:var(--text-muted)]" />
                  : e.etape === 'termine'
                    ? <Check className="w-3.5 h-3.5 flex-shrink-0 text-emerald-500" />
                    : e.etape === 'annule'
                      ? <X className="w-3.5 h-3.5 flex-shrink-0 text-[color:var(--text-muted)]" />
                      : <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-amber-500" />}
                <span className="text-xs font-medium truncate flex-1 text-[color:var(--text-primary)]">{e.nom}</span>
                <span className="text-[10px] text-[color:var(--text-muted)] flex-shrink-0">{libelleEtape(e)}</span>
              </div>
              {(e.etape === 'preparation' || e.etape === 'transfert') && (
                <div className="h-1 rounded-full bg-[#7c3aed]/20 overflow-hidden">
                  <div className="h-full rounded-full bg-[#7c3aed] transition-all duration-300" style={{ width: `${Math.round(e.progression * 100)}%` }} />
                </div>
              )}
              {e.erreur && (e.etape === 'echec' || e.etape === 'interrompu') && (
                <p className="text-[11px] leading-snug text-[color:var(--text-muted)]">{e.erreur}</p>
              )}
              <div className="flex items-center gap-3 text-[11px]">
                {enCours && (
                  <button type="button" className="underline text-[color:var(--text-muted)]" onClick={() => onAnnuler(e.operationId)}>Annuler</button>
                )}
                {peutReprendre && (
                  <button type="button" className="inline-flex items-center gap-1 underline text-[color:var(--accent)]" onClick={() => onReprendre(e.operationId)}>
                    <RotateCcw className="w-3 h-3" />Reprendre
                  </button>
                )}
                {doitChoisir && onChoisirFichier && (
                  <button type="button" className="inline-flex items-center gap-1 underline text-[color:var(--accent)]" onClick={() => onChoisirFichier(e.operationId)}>
                    <FileUp className="w-3 h-3" />Choisir le fichier
                  </button>
                )}
                {!enCours && onRetirer && (
                  <button type="button" className="underline text-[color:var(--text-muted)]" onClick={() => onRetirer(e.operationId)}>
                    {e.etape === 'echec' || e.etape === 'interrompu' ? 'Abandonner' : 'Retirer'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {mobile && actifs && (
        <p className="text-[11px] leading-snug text-[color:var(--text-muted)]">{MESSAGE_MOBILE}</p>
      )}
    </div>
  );
}

/** Reprise d'un fichier ; une reprise refusée est annoncée (fichier différent…). */
export function reprendreDepot(id: string, fichier?: File): void {
  try { fileDepot.reprendre(id, fichier); } catch (err) { toast.error((err as Error).message); }
}

/**
 * Envois échoués ou interrompus HORS du lot suivi par la modale (lot 31,
 * L31-5) : c'est ici, dans la modale d'ajout, qu'ils se reprennent depuis la
 * suppression du suivi flottant — y compris après fermeture de l'onglet
 * (fichier à resélectionner).
 */
export function UploadResumeSection({ lotSuivi, mobile }: { lotSuivi: string | null; mobile?: boolean }) {
  const { elements } = useFileDepot();
  const inputRef = useRef<HTMLInputElement>(null);
  const cibleRef = useRef<string | null>(null);
  // Fichiers repris depuis cette section : ils y restent visibles pendant
  // l'envoi et jusqu'à leur issue (sinon ils disparaîtraient au clic).
  const [suivis, setSuivis] = useState<ReadonlySet<string>>(() => new Set());
  const annonces = useRef(new Set<string>());
  const suivre = (id: string) => setSuivis((s) => new Set(s).add(id));

  // Un envoi restauré (onglet refermé) n'a plus de fin de lot en mémoire :
  // sa réussite rafraîchit ici les listes et « À traiter ».
  useEffect(() => {
    for (const e of elements) {
      if (!suivis.has(e.operationId) || e.etape !== 'termine' || annonces.current.has(e.operationId)) continue;
      annonces.current.add(e.operationId);
      window.dispatchEvent(new CustomEvent('document-added'));
      window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
    }
  }, [elements, suivis]);

  const aReprendre = elements.filter((e) => e.lotId !== lotSuivi && (suivis.has(e.operationId) || envoisAReprendre([e], lotSuivi).length > 0));
  if (aReprendre.length === 0) return null;
  const restants = envoisAReprendre(aReprendre, lotSuivi).length;
  const enCours = aReprendre.some(estActif);
  return (
    <div data-upload-resume role="alert" className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_DEPOT}
        className="hidden"
        onChange={(ev) => {
          const f = ev.target.files?.[0];
          const id = cibleRef.current;
          ev.target.value = '';
          cibleRef.current = null;
          if (f && id) { suivre(id); reprendreDepot(id, f); }
        }}
      />
      <div className="flex items-center gap-2 text-sm">
        {restants > 0
          ? <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-500" />
          : enCours
            ? <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin text-[color:var(--text-muted)]" />
            : <Check className="w-4 h-4 flex-shrink-0 text-emerald-500" />}
        <span className="font-medium text-[color:var(--text-primary)]">
          {restants > 1 ? `${restants} envois à reprendre` : restants === 1 ? '1 envoi à reprendre' : enCours ? 'Reprise en cours…' : 'Reprise terminée'}
        </span>
      </div>
      <UploadQueuePanel
        elements={aReprendre}
        mobile={mobile}
        onAnnuler={(id) => fileDepot.annuler(id)}
        onReprendre={(id) => { suivre(id); reprendreDepot(id); }}
        onChoisirFichier={(id) => { cibleRef.current = id; inputRef.current?.click(); }}
        onRetirer={(id) => fileDepot.retirer(id)}
      />
    </div>
  );
}
