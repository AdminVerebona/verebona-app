"use client";

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarDays, FileText, Package, X } from 'lucide-react';
import { UnifiedDocumentDialog } from '@/components/documents/unified-document-dialog';
import { CreateAgendaItemDrawer } from '@/components/agenda/CreateAgendaItemDrawer';
import { AssetFormDialog } from '@/components/AssetFormDialog';
import { useSession } from '@/hooks/useSession';

interface MobileActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ActionType = 'file' | 'agenda' | 'asset' | null;

const ACTIONS = [
  {
    id: 'file' as const,
    icon: FileText,
    iconBg: 'bg-blue-500/15',
    iconColor: 'text-blue-400',
    label: 'Ajouter un document',
    sub: 'Photo, vidéo, PDF, scan ou fichier',
  },
  {
    id: 'agenda' as const,
    icon: CalendarDays,
    iconBg: 'bg-violet-500/15',
    iconColor: 'text-violet-400',
    label: 'Ajouter à l\'agenda',
    sub: 'Échéance, renouvellement ou rappel',
  },
  {
    id: 'asset' as const,
    icon: Package,
    iconBg: 'bg-emerald-500/15',
    iconColor: 'text-emerald-400',
    label: 'Ajouter un bien',
    sub: 'Logement, véhicule, matériel…',
  },
];

export function MobileActionsSheet({ open, onOpenChange }: MobileActionsSheetProps) {
  const { user } = useSession();
  const [selectedAction, setSelectedAction] = useState<ActionType>(null);
  const [capturedFiles, setCapturedFiles] = useState<File[]>([]);

  const handleActionSelect = (action: ActionType) => {
    onOpenChange(false);
    if (action === 'file') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = [
        'image/*',
        'video/mp4',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'video/x-matroska',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'text/csv',
      ].join(',');
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          setCapturedFiles([file]);
          setSelectedAction('file');
        }
      };
      input.click();
    } else {
      setSelectedAction(action);
    }
  };

  const handleCloseAction = () => {
    setSelectedAction(null);
    setCapturedFiles([]);
  };

  return (
    <>
      {/* Bottom sheet overlay */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm md:hidden"
              onClick={() => onOpenChange(false)}
            />

            {/* Sheet */}
            <motion.div
              key="sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 320 }}
              className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
            >
              <div className="bg-[color:var(--bg-card)] border-t border-[color:var(--border-subtle)] rounded-t-3xl shadow-2xl pb-[env(safe-area-inset-bottom)]">

                {/* Handle */}
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[color:var(--border-subtle)]" />
                </div>

                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-3 pb-5">
                  <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
                    Ajouter
                  </h2>
                  <button
                    onClick={() => onOpenChange(false)}
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-[color:var(--bg-page)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Actions */}
                <div className="px-4 pb-6 space-y-2.5">
                  {ACTIONS.map((action, i) => (
                    <motion.button
                      key={action.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05, duration: 0.2 }}
                      onClick={() => handleActionSelect(action.id)}
                      className="w-full flex items-center gap-4 px-4 py-4 rounded-2xl bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)] active:scale-[0.98] transition-all hover:border-[color:var(--accent)]/40 hover:bg-[color:var(--accent-soft)] group"
                    >
                      {/* Icon bubble */}
                      <div className={`w-11 h-11 flex-shrink-0 rounded-xl flex items-center justify-center ${action.iconBg}`}>
                        <action.icon className={`w-5 h-5 ${action.iconColor}`} />
                      </div>

                      {/* Text */}
                      <div className="flex-1 text-left min-w-0">
                        <div className="font-semibold text-sm text-[color:var(--text-primary)] leading-tight">
                          {action.label}
                        </div>
                        <div className="text-xs text-[color:var(--text-muted)] mt-0.5 leading-snug">
                          {action.sub}
                        </div>
                      </div>

                      {/* Arrow */}
                      <svg className="w-4 h-4 text-[color:var(--text-muted)] group-hover:text-[color:var(--accent)] transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </motion.button>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Sub-dialogs (rendered outside the sheet so they don't get clipped) */}
      {selectedAction === 'file' && capturedFiles.length > 0 && (
        <UnifiedDocumentDialog
          open={true}
          onOpenChange={(v) => { if (!v) handleCloseAction(); }}
          initialFiles={capturedFiles}
          initialSource="file"
          onSuccess={handleCloseAction}
        />
      )}

      {selectedAction === 'agenda' && (
        <CreateAgendaItemDrawer
          open={true}
          onClose={handleCloseAction}
          onMutated={handleCloseAction}
        />
      )}

      {selectedAction === 'asset' && user?.id && (
        <AssetFormDialog
          open={true}
          onOpenChange={(v) => { if (!v) handleCloseAction(); }}
          userId={user.id}
          onSuccess={handleCloseAction}
        />
      )}
    </>
  );
}
