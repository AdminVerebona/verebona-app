"use client"

import { useState, useEffect, useCallback } from 'react';
import { X, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

interface UploadNoticeBannerProps {
  onClose?: () => void;
}

export function UploadNoticeBanner({ onClose }: UploadNoticeBannerProps) {
  const [visible, setVisible] = useState(false);
  const [hasMarkedAsSeen, setHasMarkedAsSeen] = useState(false);

  const markAsSeen = useCallback(async () => {
    if (hasMarkedAsSeen) return;
    
    setHasMarkedAsSeen(true);
    
    const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
    if (!token) return;

    try {
      await fetch('/api/users/me/upload-notice', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
    } catch (error) {
      console.error('[UploadNoticeBanner] Error marking notice as seen:', error);
    }
  }, [hasMarkedAsSeen]);

  useEffect(() => {
    const checkUserStatus = async () => {
      const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
      if (!token) return;

      try {
        const response = await fetch('/api/users/me', {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const userData = await response.json();
          if (userData.hasSeenUploadNotice === false) {
            setVisible(true);
            markAsSeen();
          }
        }
      } catch (error) {
        console.error('[UploadNoticeBanner] Error checking user status:', error);
      }
    };

    checkUserStatus();
  }, [markAsSeen]);

  const handleClose = () => {
    setVisible(false);
    onClose?.();
  };

  if (!visible) return null;

  return (
    <div className="w-full mb-4 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-blue-800 dark:text-blue-200 leading-relaxed">
            En déposant un document, vous acceptez qu'il soit traité conformément aux{' '}
            <Link 
              href="/cgvu" 
              target="_blank" 
              rel="noopener noreferrer"
              className="font-medium underline hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
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
          className="flex-shrink-0 h-8 w-8 p-0 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-900/50"
          aria-label="Fermer"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
