export function ParallaxMark({
  className = '',
  title,
}: {
  readonly className?: string;
  readonly title?: string;
}) {
  return (
    <svg
      className={`parallax-mark${className ? ` ${className}` : ''}`}
      viewBox="0 0 64 48"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path className="pm-plane" d="M32 8 9 13v26l23-5Z" />
      <path className="pm-plane" d="M32 8l23 5v26l-23-5Z" />
      <path className="pm-ray" d="M21 28 33 44" />
      <path className="pm-ray" d="M45 28 33 44" />
      <path className="pm-image pm-image-a" d="M20.5 16.2 32 14.3v13.8L20.5 27Z" />
      <path className="pm-image pm-image-b" d="M32 14.3 45.5 17v10L32 28.1Z" />
      <path className="pm-seam" d="M32 8v26" />
      <circle className="pm-eye" cx="33" cy="44" r="2.2" />
      <path className="pm-tick" d="M4 1v6M1 4h6" />
      <path className="pm-tick" d="M60 1v6M57 4h6" />
      <path className="pm-tick" d="M4 41v6M1 44h6" />
      <path className="pm-tick" d="M60 41v6M57 44h6" />
    </svg>
  );
}

export function BrandLockup({
  compact = false,
  className = '',
}: {
  readonly compact?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={`brand-lockup${compact ? ' brand-lockup-compact' : ''}${
        className ? ` ${className}` : ''
      }`}
    >
      <ParallaxMark className="brand-mark" />
      <span className="brand-words">
        Parallax <span className="brand-slash">/</span> Print
      </span>
      {!compact ? <span className="brand-sub">Digital alpha</span> : null}
    </span>
  );
}
