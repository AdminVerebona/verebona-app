import { ReactNode } from 'react';
import { FollowTheme } from '@/components/FollowTheme';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-page">
      <FollowTheme />
      {children}
    </div>
  );
}
