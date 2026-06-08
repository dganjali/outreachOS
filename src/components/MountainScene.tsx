// Layered forest-green mountain range for the landing hero.
// Atmospheric perspective: back ridges lighter + lower chroma, front ridges
// darker. Soft orb, drifting mist, twinkling stars. Pure decoration (aria-hidden).

const STARS = [
  { cx: 120, cy: 90, r: 1.4, d: 0 },
  { cx: 240, cy: 150, r: 1.0, d: 1.1 },
  { cx: 360, cy: 70, r: 1.6, d: 2.2 },
  { cx: 480, cy: 130, r: 1.1, d: 0.6 },
  { cx: 610, cy: 60, r: 1.3, d: 1.7 },
  { cx: 720, cy: 120, r: 1.0, d: 2.8 },
  { cx: 150, cy: 200, r: 1.0, d: 3.1 },
  { cx: 300, cy: 230, r: 1.2, d: 0.9 },
  { cx: 900, cy: 80, r: 1.5, d: 1.4 },
  { cx: 1020, cy: 140, r: 1.0, d: 2.0 },
  { cx: 1140, cy: 70, r: 1.3, d: 0.4 },
  { cx: 1260, cy: 130, r: 1.1, d: 2.5 },
  { cx: 1340, cy: 60, r: 1.5, d: 1.2 },
  { cx: 820, cy: 200, r: 1.0, d: 3.3 },
  { cx: 980, cy: 240, r: 1.2, d: 0.7 },
  { cx: 1200, cy: 210, r: 1.0, d: 1.9 },
  { cx: 60, cy: 130, r: 1.2, d: 2.6 },
  { cx: 560, cy: 210, r: 1.0, d: 1.5 },
  { cx: 680, cy: 250, r: 1.1, d: 0.3 },
  { cx: 1400, cy: 180, r: 1.2, d: 2.3 },
];

export function MountainScene({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        <linearGradient id="ms-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.16 0.040 168)" />
          <stop offset="55%" stopColor="oklch(0.24 0.060 159)" />
          <stop offset="100%" stopColor="oklch(0.33 0.072 155)" />
        </linearGradient>
        <radialGradient id="ms-orb" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="oklch(0.94 0.090 135)" stopOpacity="0.95" />
          <stop offset="40%" stopColor="oklch(0.82 0.110 145)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="oklch(0.82 0.110 145)" stopOpacity="0" />
        </radialGradient>
        <filter id="ms-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <filter id="ms-mist" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
      </defs>

      {/* sky */}
      <rect x="0" y="0" width="1440" height="900" fill="url(#ms-sky)" />

      {/* glowing orb */}
      <g className="ms-orb">
        <circle cx="1090" cy="250" r="180" fill="url(#ms-orb)" filter="url(#ms-soft)" />
        <circle cx="1090" cy="250" r="58" fill="oklch(0.95 0.060 130)" opacity="0.92" />
      </g>

      {/* stars */}
      <g className="ms-stars">
        {STARS.map((s, i) => (
          <circle
            key={i}
            className="ms-star"
            cx={s.cx}
            cy={s.cy}
            r={s.r}
            fill="oklch(0.95 0.030 130)"
            style={{ animationDelay: `${s.d}s` }}
          />
        ))}
      </g>

      {/* far mist band */}
      <g className="ms-mist">
        <ellipse cx="500" cy="470" rx="620" ry="48" fill="oklch(0.86 0.04 150)" opacity="0.10" filter="url(#ms-mist)" />
        <ellipse cx="1080" cy="560" rx="560" ry="44" fill="oklch(0.86 0.04 150)" opacity="0.09" filter="url(#ms-mist)" />
      </g>

      {/* ridge 5 — farthest */}
      <path
        d="M0,420 L180,360 L340,402 L520,300 L720,382 L900,318 L1120,392 L1320,338 L1440,402 L1440,900 L0,900 Z"
        fill="oklch(0.33 0.045 162)"
      />
      {/* ridge 4 */}
      <path
        d="M0,520 L220,442 L420,502 L600,398 L820,470 L1040,418 L1260,502 L1440,458 L1440,900 L0,900 Z"
        fill="oklch(0.285 0.052 160)"
      />
      {/* near mist between 4 and 3 */}
      <ellipse className="ms-mist-2" cx="720" cy="560" rx="900" ry="36" fill="oklch(0.88 0.03 150)" opacity="0.08" filter="url(#ms-mist)" />
      {/* ridge 3 */}
      <path
        d="M0,600 L160,540 L360,592 L560,498 L780,580 L1000,520 L1240,602 L1440,560 L1440,900 L0,900 Z"
        fill="oklch(0.245 0.056 159)"
      />
      {/* ridge 2 */}
      <path
        d="M0,690 L200,640 L420,702 L640,608 L880,690 L1100,640 L1340,702 L1440,680 L1440,900 L0,900 Z"
        fill="oklch(0.205 0.058 158)"
      />
      {/* ridge 1 — front, darkest */}
      <path
        d="M0,782 L240,740 L480,800 L720,718 L960,792 L1200,742 L1440,790 L1440,900 L0,900 Z"
        fill="oklch(0.155 0.052 159)"
      />
      {/* topographic contour lines on the front ridge */}
      <path
        d="M0,802 L240,760 L480,820 L720,738 L960,812 L1200,762 L1440,810"
        fill="none"
        stroke="oklch(0.42 0.060 156)"
        strokeWidth="1.2"
        opacity="0.45"
      />
      <path
        d="M0,824 L240,782 L480,842 L720,760 L960,834 L1200,784 L1440,832"
        fill="none"
        stroke="oklch(0.40 0.055 156)"
        strokeWidth="1.2"
        opacity="0.30"
      />
    </svg>
  );
}

// Topographic contour texture. Stacked wavy elevation lines, like a topo map.
// Uses currentColor + opacity so callers tone it via CSS (dark band vs. soft).
export function ContourField({ className }: { className?: string }) {
  const W = 1440;
  const H = 700;
  const count = 13;
  const amp = 15;
  const step = 80;
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = (i / (count - 1)) * H;
    const phase = i * 0.7;
    let d = `M0,${(base + amp * Math.sin(phase)).toFixed(1)}`;
    for (let x = step; x <= W; x += step) {
      const y = base + amp * Math.sin(x * 0.011 + phase) + amp * 0.35 * Math.sin(x * 0.026 + phase * 1.6);
      d += ` L${x},${y.toFixed(1)}`;
    }
    lines.push(d);
  }
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      role="presentation"
    >
      {lines.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1" />
      ))}
    </svg>
  );
}

// Smaller silhouette echo for the bottom CTA band.
export function RidgeSilhouette({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1440 220"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      role="presentation"
    >
      <path
        d="M0,120 L200,80 L420,130 L640,70 L880,120 L1100,76 L1340,124 L1440,96 L1440,220 L0,220 Z"
        fill="oklch(0.34 0.072 156)"
        opacity="0.6"
      />
      <path
        d="M0,160 L240,124 L480,168 L720,110 L960,160 L1200,118 L1440,162 L1440,220 L0,220 Z"
        fill="oklch(0.27 0.070 157)"
        opacity="0.85"
      />
    </svg>
  );
}
