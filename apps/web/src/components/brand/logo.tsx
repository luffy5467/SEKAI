/**
 * The SEKAI identity.
 *
 * Emblem: an open ensō-style ring (the world), a horizon line through it (the
 * one shared screen) and a small wisteria star (the people watching). Drawn
 * for SEKAI; not derived from any existing logo.
 */

export const BRAND = {
  name: 'SEKAI',
  nameJa: '世界',
  tagline: 'One world. One screen. Together.',
} as const;

export function Emblem({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <circle
        cx="24"
        cy="24"
        r="18"
        stroke="var(--color-shu)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray="100 13"
        transform="rotate(-62 24 24)"
      />
      <path d="M8 27.5h32" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" />
      <circle cx="35" cy="14" r="2.6" fill="var(--color-fuji)" />
    </svg>
  );
}

export function Logo({
  className = '',
  showJapanese = true,
}: {
  className?: string;
  showJapanese?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Emblem className="size-7 shrink-0 text-foreground" />
      <span className="flex items-baseline gap-1.5">
        <span className="text-[15px] font-semibold tracking-[0.3em]">{BRAND.name}</span>
        {showJapanese ? (
          <span lang="ja" className="font-jp text-[11px] font-medium text-muted-foreground">
            {BRAND.nameJa}
          </span>
        ) : null}
      </span>
    </span>
  );
}
