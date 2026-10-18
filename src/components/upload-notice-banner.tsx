"use client"

import { useState, useEffect, useRef } from 'react';
import { X, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { apiClient } from '@/lib/api-client';
import { useSession } from '@/hooks/useSession';

interface UploadNoticeBannerProps {
  onClose?: () => void;
}

/**
 * Avis de dépôt affiché une fois. L'état vient de la session partagée
 * (`useSession`, APP-PERF-04) : plus de lecture propre de `/api/users/me` à
 * chaque ouverture du dialogue. Une fois l'avis affiché, il est marqué vu
 * côté serveur et la session locale est mise à jour (`user-profile-updated`) :
 * il ne réapparaît pas à la prochaine ouverture.
 */
export function UploadNoticeBanner({ onClose }: UploadNoticeBannerProps) {
  const { user } = useSession();
  const [visible, setVisible] = useState(false);
  const affiche = useRef(false);

  useEffect(() => {
    if (affiche.current || !user || user.hasSeenUploadNotice !== false) return;
    affiche.current = true;
    setVisible(true);
    const id = user.id;
    apiClient
      .post('/api/users/me/upload-notice', undefined, { onAuthFailure: 'silent' })
      .then(() => {
        window.dispatchEvent(new CustomEvent('user-profile-updated', { detail: { id, hasSeenUploadNotice: true } }));
      })
      .catch((error) => {
        console.error('[UploadNoticeBanner] Error marking notice as seen:', error);
      });
  }, [user]);

  const handleClose = () => {
    setVisible(false);
    onClose?.();
  };

  if (!visible) return null;

  return (
    <div className="w-full mb-4 rounded-lg border border-[color:var(--border-info)] bg-[color:var(--accent-soft)] p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <Info className="h-5 w-5 text-[color:var(--accent)] flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[color:var(--accent)] leading-relaxed">
            En déposant un document, vous acceptez qu'il soit traité conformément aux{' '}
            <Link 
              href="/cgvu" 
              target="_blank" 
              rel="noopener noreferrer"
              className="font-medium underline hover:text-[color:var(--accent)] transition-colors"
            >
              conditions générales
            </Link>
            {' '}pour son stockage, sa prévisualisation et, si votre offre le permet, son analyse automatisée (OCR).
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="flex-shrink-0 h-8 w-8 p-0 text-[color:var(--accent)] hover:text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)]"
          aria-label="Fermer"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
