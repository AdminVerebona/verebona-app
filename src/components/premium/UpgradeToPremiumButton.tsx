/**
 * Bouton "Passer à Premium" réutilisable
 * SPECS V1: Redirection vers la page d'abonnement
 */

'use client';

import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface UpgradeToPremiumButtonProps {
  variant?: 'default' | 'outline' | 'secondary';
  size?: 'default' | 'sm' | 'lg';
  className?: string;
  children?: React.ReactNode;
  fullWidth?: boolean;
}

export function UpgradeToPremiumButton({
  variant = 'default',
  size = 'default',
  className = '',
  children,
  fullWidth = false,
}: UpgradeToPremiumButtonProps) {
  const router = useRouter();

  const handleClick = () => {
    router.push('/mon-compte/offres');
  };

  return (
    <Button
      onClick={handleClick}
      variant={variant}
      size={size}
      className={`${fullWidth ? 'w-full' : ''} ${className}`}
    >
      <Sparkles className="w-4 h-4 mr-2" />
      {children || 'Passer à Premium'}
    </Button>
  );
}
