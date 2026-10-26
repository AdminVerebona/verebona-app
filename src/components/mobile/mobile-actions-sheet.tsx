"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarDays, FileText, Package } from 'lucide-react';
import { useSession } from '@/hooks/useSession';
// Formulaires chargés à l'usage, jamais dans le JavaScript initial (APP-PERF-05).
import {
  LazyAssetFormDialog,
  LazyCreateAgendaItemDrawer,
  LazyUnifiedDocumentDialog,
  preloadAddForm,
} from './add-forms';
import { useWriteGuard } from '@/contexts/WriteGuardContext';

interface MobileActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Panneau aussi affiché sur ordinateur (bouton « + Ajouter » du menu
   * latéral). Par défaut, mobile seulement (`md:hidden`).
   */
  allViewports?: boolean;
  /**
   * Lot 53b (point 11) : position du bouton « + » qui ouvre le menu. Le menu
   * s'accroche à ce bouton (au-dessus du « + » mobile, sous ou à droite du
   * « + Ajouter » du menu latéral) au lieu d'un panneau latéral plein écran.
   */
  anchor?: DOMRect | null;
}

/** Largeur du menu « Ajouter » (bornée par la marge de 16 px sur mobile). */
export const ADD_MENU_WIDTH = 288;
const GUTTER = 16;

interface AddMenuPosition { left: number; top?: number; bottom?: number; origin: 'top' | 'bottom' | 'left' }

/**
 * Position du menu « Ajouter » : pure, testée. Bouton dans la moitié basse
 * (« + » de la barre mobile) → au-dessus, centré sur le bouton ; bouton
 * étroit (menu latéral replié) → à droite ; sinon → dessous, aligné à gauche.
 * Toujours dans l'écran, à 16 px des bords.
 */
export function addMenuPosition(anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'> | null | undefined, vw: number, vh: number): AddMenuPosition {
  const w = Math.min(ADD_MENU_WIDTH, vw - 2 * GUTTER);
  const clampX = (x: number) => Math.max(GUTTER, Math.min(x, vw - w - GUTTER));
  if (!anchor) return { left: clampX((vw - w) / 2), bottom: 104, origin: 'bottom' };
  if (anchor.top > vh / 2) {
    return { left: clampX(anchor.left + anchor.width / 2 - w / 2), bottom: Math.max(GUTTER, vh - anchor.top + 10), origin: 'bottom' };
  }
  if (anchor.width < 64) {
    return { left: clampX(anchor.right + 8), top: Math.max(GUTTER, anchor.top), origin: 'left' };
  }
  return { left: clampX(anchor.left), top: anchor.bottom + 6, origin: 'top' };
}

type ActionType = 'file' | 'agenda' | 'asset' | null;

const ACTIONS = [
  {
    id: 'file' as const,
    icon: FileText,
    iconBg: 'bg-[color:var(--accent-soft)]',
    iconColor: 'text-[color:var(--accent)]',
    label: 'Ajouter un document',
    sub: 'Photo, vidéo, PDF, scan ou fichier',
  },
  {
    id: 'agenda' as const,
    icon: CalendarDays,
    iconBg: 'bg-[color:var(--attention-soft)]',
    iconColor: 'text-[color:var(--attention)]',
    label: 'Ajouter à l\'agenda',
    sub: 'Échéance, renouvellement ou rappel',
  },
  {
    id: 'asset' as const,
    icon: Package,
    iconBg: 'bg-[color:var(--accent-soft)]',
    iconColor: 'text-[color:var(--accent)]',
    label: 'Ajouter un bien',
    sub: 'Logement, véhicule, matériel…',
  },
];

export function MobileActionsSheet({ open, onOpenChange, allViewports = false, anchor = null }: MobileActionsSheetProps) {
  const viewport = allViewports ? '' : ' md:hidden';
  const { user } = useSession();
  const [selectedAction, setSelectedAction] = useState<ActionType>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const retourFocus = useRef<HTMLElement | null>(null);

  /**
   * Garde déportée dans `WriteGuardContext` — même fenêtre que le bouton
   * « + » de la barre latérale, au lieu d'un bandeau qui disparaît.
   */
  const { garder } = useWriteGuard();
  const refuserEcriture = (quota?: 'assets' | 'documents'): boolean => {
    let bloque = true;
    garder(() => { bloque = false; }, quota);
    return bloque;
  };

  // Ouverture : focus sur la première action (clavier), retour au « + » à la
  // fermeture par Échap. Échap ferme aussi depuis n'importe où.
  useEffect(() => {
    if (!open) return;
    retourFocus.current = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    const t = window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false); retourFocus.current?.focus?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [open, onOpenChange]);

  const naviguerClavier = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const aller = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') aller(i + 1);
    else if (e.key === 'ArrowUp') aller(i - 1);
    else if (e.key === 'Home') aller(0);
    else if (e.key === 'End') aller(items.length - 1);
    else if (e.key === 'Tab') onOpenChange(false);
  };

  const handleActionSelect = (action: ActionType) => {
    onOpenChange(false);

    // Même garde que le « + » de la barre latérale : on n'ouvre pas un
    // formulaire pour une action que le serveur refusera. Le refus est
    // annoncé avec son chemin de sortie.
    if (action === 'asset' && refuserEcriture('assets')) return;
    if (action === 'file' && refuserEcriture('documents')) return;
    // L'agenda manquait : ajouter une échéance est une écriture, refusée par
    // le serveur comme les autres. Elle n'a pas de quota propre.
    if (action === 'agenda' && refuserEcriture()) return;

    if (action === 'file') {
      // Lot 53b (point 11) : le tiroir d'ajout de document s'ouvre (dépôt,
      // sélection multiple, lien web) au lieu de l'explorateur de fichiers à
      // choix unique. Le tri des fichiers reste celui du tiroir.
      preloadAddForm('file');
    }
    setSelectedAction(action);
  };

  const handleCloseAction = () => {
    setSelectedAction(null);
  };

  const vw = typeof window !== 'undefined' ? window.innerWidth : 390;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 844;
  const pos = addMenuPosition(anchor, vw, vh);
  const decalage = pos.origin === 'bottom' ? 6 : pos.origin === 'top' ? -6 : 0;

  return (
    <>
      {/* Lot 53b (point 11) : petit menu accroché au « + » (plus de panneau
          latéral plein écran). Clic à côté, Échap ou choix d'une action :
          fermeture. Ni voile sombre ni flou. */}
      <AnimatePresence>
        {open && (
          <>
            <div
              key="catcher"
              aria-hidden
              className={`fixed inset-0 z-50${viewport}`}
              onClick={() => onOpenChange(false)}
            />
            <motion.div
              key="menu"
              ref={menuRef}
              role="menu"
              aria-label="Ajouter"
              onKeyDown={naviguerClavier}
              initial={{ opacity: 0, y: decalage }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: decalage }}
              transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: Math.min(ADD_MENU_WIDTH, vw - 32), transformOrigin: pos.origin === 'bottom' ? 'bottom center' : pos.origin === 'top' ? 'top left' : 'left top' }}
              className={`fixed z-50 rounded-[16px] border border-[color:var(--border)] bg-[color:var(--bg-card)] p-1.5 shadow-[var(--vb-shadow-card)]${viewport}`}
            >
              {ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => handleActionSelect(action.id)}
                  // Préchargement sur intention : pointeur, toucher ou
                  // focus clavier sur l'action — pas à l'ouverture du
                  // menu, ni au chargement de la page.
                  onPointerEnter={() => preloadAddForm(action.id)}
                  onTouchStart={() => preloadAddForm(action.id)}
                  onFocus={() => preloadAddForm(action.id)}
                  className="flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2.5 text-left transition-colors duration-[180ms] hover:bg-[color:var(--accent-soft)] focus-visible:bg-[color:var(--accent-soft)]"
                >
                  <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] ${action.iconBg}`}>
                    <action.icon className={`h-[18px] w-[18px] ${action.iconColor}`} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold leading-tight text-[color:var(--text-primary)]">{action.label}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-[color:var(--text-muted)]">{action.sub}</span>
                  </span>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Formulaires (hors du menu pour ne pas être rognés), montés
          seulement une fois l'action choisie ET autorisée par la garde. */}
      {selectedAction === 'file' && (
        <LazyUnifiedDocumentDialog
          open={true}
          onOpenChange={(v) => { if (!v) handleCloseAction(); }}
          onSuccess={handleCloseAction}
        />
      )}

      {selectedAction === 'agenda' && (
        <LazyCreateAgendaItemDrawer
          open={true}
          onClose={handleCloseAction}
          onMutated={handleCloseAction}
        />
      )}

      {selectedAction === 'asset' && user?.id && (
        <LazyAssetFormDialog
          open={true}
          onOpenChange={(v) => { if (!v) handleCloseAction(); }}
          userId={user.id}
          onSuccess={handleCloseAction}
        />
      )}
    </>
  );
}
