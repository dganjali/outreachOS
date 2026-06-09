// Light, airy mountain hero in the Cluely register, in OutreachOS green.
// Pale teal-green sky fading to a warm horizon, a soft sun low on the right,
// layered ranges with atmospheric perspective (paler toward the back) and a
// snow-lit edge on the front ridges. Pure decoration (aria-hidden).

export function MountainHero({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      role="presentation"
    >
      <defs>
        <linearGradient id="mh-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.62 0.078 188)" />
          <stop offset="42%" stopColor="oklch(0.78 0.055 172)" />
          <stop offset="74%" stopColor="oklch(0.91 0.030 150)" />
          <stop offset="100%" stopColor="oklch(0.97 0.014 110)" />
        </linearGradient>
        <radialGradient id="mh-sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="oklch(0.99 0.020 100)" stopOpacity="0.98" />
          <stop offset="45%" stopColor="oklch(0.96 0.050 120)" stopOpacity="0.40" />
          <stop offset="100%" stopColor="oklch(0.96 0.050 120)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mh-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.70 0.060 162)" />
          <stop offset="100%" stopColor="oklch(0.50 0.085 158)" />
        </linearGradient>
        <linearGradient id="mh-front2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.78 0.048 166)" />
          <stop offset="100%" stopColor="oklch(0.61 0.072 160)" />
        </linearGradient>
        <filter id="mh-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="30" />
        </filter>
        <filter id="mh-haze" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="20" />
        </filter>
      </defs>

      {/* sky */}
      <rect x="0" y="0" width="1440" height="900" fill="url(#mh-sky)" />

      {/* sun low on the right, near the horizon */}
      <g className="mh-sun">
        <circle cx="1180" cy="540" r="240" fill="url(#mh-sun)" filter="url(#mh-soft)" />
        <circle cx="1180" cy="540" r="62" fill="oklch(0.99 0.018 100)" opacity="0.95" />
      </g>

      {/* atmospheric haze near the horizon */}
      <g className="mh-haze">
        <ellipse cx="560" cy="560" rx="720" ry="46" fill="oklch(0.97 0.02 140)" opacity="0.45" filter="url(#mh-haze)" />
        <ellipse cx="1080" cy="600" rx="620" ry="40" fill="oklch(0.97 0.02 130)" opacity="0.40" filter="url(#mh-haze)" />
      </g>

      {/* ranges, back to front (atmospheric perspective) */}
      <path d="M0,470 L240,430 L480,470 L760,420 L1020,460 L1280,430 L1440,465 L1440,900 L0,900 Z" fill="oklch(0.86 0.030 180)" />
      <path d="M0,520 L220,476 L460,520 L720,460 L1000,510 L1260,470 L1440,515 L1440,900 L0,900 Z" fill="oklch(0.80 0.040 174)" />
      <path d="M0,565 L260,516 L520,565 L780,500 L1060,560 L1320,516 L1440,560 L1440,900 L0,900 Z" fill="oklch(0.73 0.050 168)" />
      <path d="M0,615 L200,560 L440,615 L700,545 L980,610 L1240,560 L1440,608 L1440,900 L0,900 Z" fill="oklch(0.66 0.060 164)" />

      {/* front-2 with subtle snow gradient */}
      <path d="M0,675 L240,615 L500,680 L760,600 L1040,675 L1300,620 L1440,672 L1440,900 L0,900 Z" fill="url(#mh-front2)" />
      {/* snow-lit edge on front-2 */}
      <path d="M0,675 L240,615 L500,680 L760,600 L1040,675 L1300,620 L1440,672" fill="none" stroke="oklch(0.96 0.015 150)" strokeWidth="1.5" opacity="0.45" />

      {/* front range */}
      <path d="M0,755 L260,700 L520,765 L800,690 L1080,760 L1340,705 L1440,752 L1440,900 L0,900 Z" fill="url(#mh-front)" />
      {/* snow-lit edge on the front ridge */}
      <path d="M0,755 L260,700 L520,765 L800,690 L1080,760 L1340,705 L1440,752" fill="none" stroke="oklch(0.97 0.012 150)" strokeWidth="1.8" opacity="0.6" />
    </svg>
  );
}
