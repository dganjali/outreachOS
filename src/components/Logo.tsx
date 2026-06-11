import { Link } from 'react-router-dom';

interface LogoProps {
  size?: number;
  withWordmark?: boolean;
  to?: string | null;
  variant?: 'default' | 'mono-light' | 'mono-dark';
  className?: string;
}

export function LogoMark({ size = 28, variant = 'default' }: { size?: number; variant?: LogoProps['variant'] }) {
  const stroke = variant === 'mono-light' ? '#F4F7FA' : variant === 'mono-dark' ? '#0f172a' : '#F4F7FA';
  const fillPrimary = variant === 'mono-light' ? '#F4F7FA' : variant === 'mono-dark' ? '#0f172a' : '#F4F7FA';
  const fillAccent = variant === 'mono-light' ? 'rgba(255,255,255,0.55)' : '#42A478';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="2" y="2" width="28" height="28" rx="7" stroke={stroke} strokeWidth="1.5" fill="none" />
      <path
        d="M9 22 L16 9 L23 22"
        stroke={fillPrimary}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="23" cy="22" r="2.6" fill={fillAccent} />
    </svg>
  );
}

export function Logo({ size = 28, withWordmark = true, to = '/', variant = 'default', className }: LogoProps) {
  const wordmarkColor =
    variant === 'mono-dark' ? '#0f172a' : 'hsl(var(--foreground))';

  const inner = (
    <span className={`logo ${className ?? ''}`}>
      <LogoMark size={size} variant={variant} />
      {withWordmark && (
        <span className="logo-wordmark" style={{ color: wordmarkColor }}>
          OutreachOS
        </span>
      )}
    </span>
  );

  if (to) {
    return (
      <Link to={to} className="logo-link" aria-label="OutreachOS home">
        {inner}
      </Link>
    );
  }
  return inner;
}
