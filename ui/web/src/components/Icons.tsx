// The icon set: hand-written inline SVG in the Lucide style (24x24 grid, 1.75 stroke,
// currentColor). No icon font and no external file, so the CSP needs nothing extra.
// Without a title an icon is decoration (aria-hidden); with a title it is an image with a name.
import type { ReactNode } from "react";

export type IconProps = { size?: number; className?: string; title?: string };

export function Icon({ size = 20, className, title, children }: IconProps & { children: ReactNode }) {
  const label = title
    ? { role: "img" as const }
    : { "aria-hidden": true as const, focusable: "false" as const };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      className={className ? `icon ${className}` : "icon"} {...label}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

const make = (name: string, body: ReactNode) => {
  const Named = (props: IconProps) => <Icon {...props}>{body}</Icon>;
  Named.displayName = name;
  return Named;
};

export const LayoutDashboard = make("LayoutDashboard", <>
  <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
  <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
</>);

export const MessageSquare = make("MessageSquare",
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);

export const TrendingUp = make("TrendingUp", <>
  <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" />
</>);

export const TrendingDown = make("TrendingDown", <>
  <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" /><polyline points="16 17 22 17 22 11" />
</>);

export const Wallet = make("Wallet", <>
  <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
  <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
</>);

export const PiggyBank = make("PiggyBank", <>
  <path d="M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2V5z" />
  <path d="M2 9v1c0 1.1.9 2 2 2h1" /><path d="M16 11h.01" />
</>);

export const LineChart = make("LineChart", <>
  <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
</>);

export const BarChart = make("BarChart", <>
  <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
</>);

export const Target = make("Target", <>
  <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
</>);

export const Layers = make("Layers", <>
  <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
  <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
</>);

export const ShieldCheck = make("ShieldCheck", <>
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /><path d="m9 12 2 2 4-4" />
</>);

export const AlertTriangle = make("AlertTriangle", <>
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
  <path d="M12 9v4" /><path d="M12 17h.01" />
</>);

export const CheckCircle = make("CheckCircle", <>
  <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
</>);

export const Info = make("Info", <>
  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
</>);

export const Send = make("Send", <>
  <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
</>);

export const Sparkles = make("Sparkles", <>
  <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
  <path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" />
</>);

export const Calendar = make("Calendar", <>
  <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" />
</>);

export const ArrowUpRight = make("ArrowUpRight", <>
  <path d="M7 17 17 7" /><path d="M7 7h10v10" />
</>);

export const ArrowDownRight = make("ArrowDownRight", <>
  <path d="m7 7 10 10" /><path d="M17 7v10H7" />
</>);

export const Coins = make("Coins", <>
  <circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
  <path d="M7 6h1v4" /><path d="m16.71 13.88.7.71-2.82 2.82" />
</>);

export const Clock = make("Clock", <>
  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
</>);

export const Database = make("Database", <>
  <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" />
</>);

export const Inbox = make("Inbox", <>
  <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
  <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
</>);

export const Table = make("Table", <>
  <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" />
</>);

export const User = make("User", <>
  <circle cx="12" cy="8" r="4" /><path d="M20 21a8 8 0 0 0-16 0" />
</>);

export const Bot = make("Bot", <>
  <rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4H8" />
  <path d="M2 14h2" /><path d="M20 14h2" /><path d="M9 13v2" /><path d="M15 13v2" />
</>);

export const Square = make("Square", <rect x="5" y="5" width="14" height="14" rx="2" />);

export const ChevronDown = make("ChevronDown", <path d="m6 9 6 6 6-6" />);

/** The finos monogram: a gold "f" in a rounded square. Decoration; the wordmark carries the name. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 32 32" fill="none"
      className={className ? `brand-mark ${className}` : "brand-mark"} aria-hidden="true" focusable="false"
    >
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" />
      <path d="M19.5 9.5h-2.25a3 3 0 0 0-3 3V23" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <path d="M11 15h7" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <circle cx="21.5" cy="22" r="1.5" fill="currentColor" />
    </svg>
  );
}
