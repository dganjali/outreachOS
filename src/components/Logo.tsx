import { Link } from 'react-router-dom';

interface LogoProps {
  size?: number;
  withWordmark?: boolean;
  to?: string | null;
  variant?: 'default' | 'mono-light' | 'mono-dark';
  className?: string;
}

export function LogoMark({ size = 28, variant = 'default' }: { size?: number; variant?: LogoProps['variant'] }) {
  void variant;
  return (
    <img
      src="/logo-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden
      style={{ display: 'block', objectFit: 'contain' }}
    />
  );
}

export function Logo({ size = 28, withWordmark = true, to = '/', variant = 'default', className }: LogoProps) {
  void variant;

  const inner = (
    <span className={`logo ${className ?? ''}`}>
      {withWordmark ? (
        <img
          src="/logo-wordmark.png"
          alt="OutreachOS"
          height={Math.round(size * 2.4)}
          style={{ display: 'block', height: Math.round(size * 2.4), width: 'auto' }}
        />
      ) : (
        <LogoMark size={size} variant={variant} />
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
