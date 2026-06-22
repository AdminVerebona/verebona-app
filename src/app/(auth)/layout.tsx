import { ReactNode } from 'react';
import { ForceTheme } from '@/components/ForceTheme';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-page">
      <ForceTheme theme="blue" />
      {children}
    </div>
  );
}
