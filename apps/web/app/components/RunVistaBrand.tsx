export function RunVistaBrand() {
  return (
    <div className="topbar-brand">
      <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="2" y="18" width="4" height="8" rx="1" fill="var(--accent)" />
        <rect x="8" y="12" width="4" height="14" rx="1" fill="var(--accent)" />
        <rect x="14" y="6" width="4" height="20" rx="1" fill="var(--accent)" />
        <rect x="20" y="2" width="4" height="24" rx="1" fill="var(--accent)" opacity="0.4" />
      </svg>
      <div>
        <div className="topbar-brand-name">RunVista</div>
        <div className="topbar-brand-sub">Sports</div>
      </div>
    </div>
  );
}
