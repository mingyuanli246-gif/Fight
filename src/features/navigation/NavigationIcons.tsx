import type { SVGProps } from "react";

export function NotebookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7 4.5h9.5a2 2 0 0 1 2 2V18a1.5 1.5 0 0 1-1.5 1.5H7a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 7 4.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 8.5h6.5M8.5 12h6.5M8.5 15.5h4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M6.5 4.5v15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect
        x="4.5"
        y="5.5"
        width="15"
        height="14"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8 3.75v3.5M16 3.75v3.5M4.5 9.5h15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M8.25 13h2M13.75 13h2M8.25 16.5h2M13.75 16.5h2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TagIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="m12.5 5.5 5.25 5.25a2.1 2.1 0 0 1 0 2.98l-4.02 4.02a2.1 2.1 0 0 1-2.98 0L5.5 12.5V6.75A1.25 1.25 0 0 1 6.75 5.5H12.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.25" cy="9.25" r="1" fill="currentColor" />
    </svg>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M5.5 7.5h13M9 4.75h6M9.5 10.25v6M14.5 10.25v6M7.5 7.5l.6 9.1A2 2 0 0 0 10.1 18.5h3.8a2 2 0 0 0 2-1.9l.6-9.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 9.25A2.75 2.75 0 1 0 12 14.75A2.75 2.75 0 1 0 12 9.25Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 3.5 13 5.68a1 1 0 0 0 .75.56l2.4.31-.95 2.23a1 1 0 0 0 .16.92l1.56 1.82-1.95 1.22a1 1 0 0 0-.45.81l-.06 2.42-2.33-.63a1 1 0 0 0-.91.18L10 18.5 8.79 16.5a1 1 0 0 0-.86-.48l-2.41.08.62-2.34a1 1 0 0 0-.18-.91L4.5 11.03l2.01-1.12a1 1 0 0 0 .5-.78l.16-2.41 2.3.73a1 1 0 0 0 .92-.14L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
