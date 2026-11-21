// Lucide v0.468.0. See licenses/lucide.txt for copyright and license.
type IconProps = {
  size?: number;
  class?: string;
  "aria-hidden"?: "true" | "false";
  "aria-label"?: string;
};

export function BookOpen(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M12 7v14" />
    <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
  </svg>;
}

export function Check(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={["lucide-check", props.class]}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M20 6 9 17l-5-5" />
  </svg>;
}

export function ChevronDown(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="m6 9 6 6 6-6" />
  </svg>;
}

export function ChevronLeft(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="m15 18-6-6 6-6" />
  </svg>;
}

export function ChevronRight(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="m9 18 6-6-6-6" />
  </svg>;
}

export function Download(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </svg>;
}

export function FileText(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </svg>;
}

export function LayoutGrid(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </svg>;
}

export function List(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
    <path d="M3 6h.01" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M8 6h13" />
  </svg>;
}

export function LoaderCircle(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>;
}

export function Monitor(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </svg>;
}

export function Moon(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>;
}

export function RefreshCw(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>;
}

export function Rows3(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M21 9H3" />
    <path d="M21 15H3" />
  </svg>;
}

export function Save(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
  </svg>;
}

export function ScanLine(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 12h10" />
  </svg>;
}

export function Search(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>;
}

export function SlidersHorizontal(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <line x1="21" x2="14" y1="4" y2="4" />
    <line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" />
    <line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" />
    <line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" />
    <line x1="8" x2="8" y1="10" y2="14" />
    <line x1="16" x2="16" y1="18" y2="22" />
  </svg>;
}

export function Sun(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>;
}

export function Trash2(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </svg>;
}

export function TriangleAlert(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>;
}

export function Upload(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" x2="12" y1="3" y2="15" />
  </svg>;
}

export function X(props: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={props.size ?? 24} height={props.size ?? 24} class={props.class}
    aria-hidden={props["aria-hidden"]} aria-label={props["aria-label"]}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>;
}
