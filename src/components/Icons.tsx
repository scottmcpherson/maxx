import { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  agent: (props: IconProps) => (
    <IconBase {...props}><path d="m4 5 16 3-7 4-4 7-2-7-3-7Z" /><path d="m7 12 6 0" /></IconBase>
  ),
  compose: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <path d="m15.5 4.5 4 4M10 14l1-4 6.5-6.5a2 2 0 0 1 3 3L14 13l-4 1Z" />
    </IconBase>
  ),
  search: (props: IconProps) => (
    <IconBase {...props}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></IconBase>
  ),
  folder: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </IconBase>
  ),
  folderOpen: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </IconBase>
  ),
  folderPlus: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="M12 10v6M9 13h6" />
    </IconBase>
  ),
  plus: (props: IconProps) => (
    <IconBase {...props}><path d="M12 5v14M5 12h14" /></IconBase>
  ),
  expand: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M9 4H4v5M4 4l6 6M15 20h5v-5M20 20l-6-6" />
    </IconBase>
  ),
  collapse: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M4 4l6 6M10 6v4H6M20 20l-6-6M14 18v-4h4" />
    </IconBase>
  ),
  screenshot: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" />
      <rect x="8" y="8" width="8" height="8" rx="1" />
    </IconBase>
  ),
  annotation: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M17.5 12.5v2.25A3.25 3.25 0 0 1 14.25 18H9l-4.5 2 1.2-3.5A3.25 3.25 0 0 1 4 13.75V8.25A3.25 3.25 0 0 1 7.25 5H12" />
      <path d="m13.5 11.5.75-3 4.8-4.8a1.6 1.6 0 0 1 2.25 2.25l-4.8 4.8-3 .75Z" />
      <path d="m18 4.75 2.25 2.25" />
    </IconBase>
  ),
  bell: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M18 9.5a6 6 0 0 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5" />
      <path d="M10.2 19.5a2 2 0 0 0 3.6 0" />
    </IconBase>
  ),
  clock: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </IconBase>
  ),
  settings: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    </IconBase>
  ),
  sidebar: (props: IconProps) => (
    <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9 4v16" /></IconBase>
  ),
  panel: (props: IconProps) => (
    <IconBase {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M15 4v16" /></IconBase>
  ),
  // "Toggle pinned summary" — the bulleted-list glyph Codex uses for the same
  // control, so the two apps' title bars read the same way.
  summary: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="6.5" cy="9" r="1.6" />
      <circle cx="6.5" cy="15" r="1.6" />
      <path d="M11 9h7.5M11 15h7.5" />
    </IconBase>
  ),
  chevronDown: (props: IconProps) => (
    <IconBase {...props}><path d="m7 9.5 5 5 5-5" /></IconBase>
  ),
  chevronRight: (props: IconProps) => (
    <IconBase {...props}><path d="m9.5 7 5 5-5 5" /></IconBase>
  ),
  chevronLeft: (props: IconProps) => (
    <IconBase {...props}><path d="m14.5 7-5 5 5 5" /></IconBase>
  ),
  chevronUp: (props: IconProps) => (
    <IconBase {...props}><path d="m7 14.5 5-5 5 5" /></IconBase>
  ),
  globe: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.2 2.3 3.3 5.2 3.3 8.5S14.2 18.2 12 20.5c-2.2-2.3-3.3-5.2-3.3-8.5S9.8 5.8 12 3.5Z" />
    </IconBase>
  ),
  warning: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M10.3 4.2 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 16.5h.01" />
    </IconBase>
  ),
  computer: (props: IconProps) => (
    <IconBase {...props}>
      <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
      <path d="M8 20.5h8M12 16.5v4" />
    </IconBase>
  ),
  lock: (props: IconProps) => (
    <IconBase {...props}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </IconBase>
  ),
  reload: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.5 4v4.5H16" />
    </IconBase>
  ),
  arrowRight: (props: IconProps) => (
    <IconBase {...props}><path d="M5 12h14m-5-5 5 5-5 5" /></IconBase>
  ),
  arrowUp: (props: IconProps) => (
    <IconBase {...props}><path d="M12 19V5m-5 5 5-5 5 5" /></IconBase>
  ),
  arrowDown: (props: IconProps) => (
    <IconBase {...props}><path d="M12 5v14m-5-5 5 5 5-5" /></IconBase>
  ),
  download: (props: IconProps) => (
    <IconBase {...props}><path d="M12 4v11m-4-4 4 4 4-4" /><path d="M5 20h14" /></IconBase>
  ),
  stop: (props: IconProps) => (
    <IconBase {...props}><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" /></IconBase>
  ),
  close: (props: IconProps) => (
    <IconBase {...props}><path d="m7 7 10 10M17 7 7 17" /></IconBase>
  ),
  trash: (props: IconProps) => (
    <IconBase {...props}><path d="M5 7h14M9 7V4.5h6V7m2 0-1 13H8L7 7m3 4v5m4-5v5" /></IconBase>
  ),
  pin: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m14 4 6 6-3 1-4 4-1 4-7-7 4-1 4-4 1-3Z" />
      <path d="m9 15-5 5" />
    </IconBase>
  ),
  pinFilled: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m14 4 6 6-3 1-4 4-1 4-7-7 4-1 4-4 1-3Z" fill="currentColor" />
      <path d="m9 15-5 5" />
    </IconBase>
  ),
  branch: (props: IconProps) => (
    <IconBase {...props}><circle cx="7" cy="5" r="2" /><circle cx="17" cy="7" r="2" /><circle cx="7" cy="19" r="2" /><path d="M7 7v10m2-6h3a5 5 0 0 0 5-5" /></IconBase>
  ),
  environment: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </IconBase>
  ),
  commit: (props: IconProps) => (
    <IconBase {...props}><path d="M3 12h6M15 12h6" /><circle cx="12" cy="12" r="3" /></IconBase>
  ),
  terminal: (props: IconProps) => (
    <IconBase {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></IconBase>
  ),
  flask: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M9 3h6M10 3v6l-5 8.5A2.3 2.3 0 0 0 7 21h10a2.3 2.3 0 0 0 2-3.5L14 9V3" />
      <path d="M7.5 15h9" />
    </IconBase>
  ),
  sparkles: (props: IconProps) => (
    <IconBase {...props}>
      <path d="m12 3 1.35 4.15L17.5 8.5l-4.15 1.35L12 14l-1.35-4.15L6.5 8.5l4.15-1.35L12 3Z" />
      <path d="m18.5 14 .75 2.25L21.5 17l-2.25.75L18.5 20l-.75-2.25L15.5 17l2.25-.75.75-2.25Z" />
      <path d="m5 13 .6 1.9 1.9.6-1.9.6L5 18l-.6-1.9-1.9-.6 1.9-.6L5 13Z" />
    </IconBase>
  ),
  files: (props: IconProps) => (
    <IconBase {...props}><path d="M7 3.5h8l3 3v14H7z" /><path d="M15 3.5v4h3M4 7v13h10" /></IconBase>
  ),
  activity: (props: IconProps) => (
    <IconBase {...props}><path d="M3 12h4l2.2-6 4.2 12 2.3-6H21" /></IconBase>
  ),
  microphone: (props: IconProps) => (
    <IconBase {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </IconBase>
  ),
  waveform: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </IconBase>
  ),
  keyboard: (props: IconProps) => (
    <IconBase {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h.01M17 14h.01M10 14h4" />
    </IconBase>
  ),
  history: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </IconBase>
  ),
  check: (props: IconProps) => (
    <IconBase {...props}><path d="m5 12.5 4 4L19 7" /></IconBase>
  ),
  copy: (props: IconProps) => (
    <IconBase {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M6.5 15.5H5.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </IconBase>
  ),
  shuffle: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M3 7h2.8a5 5 0 0 1 4.2 2.3l2 3.4a5 5 0 0 0 4.2 2.3H20" />
      <path d="M3 17h2.8a5 5 0 0 0 3.2-1.2M20 7h-3.8a5 5 0 0 0-3.2 1.2" />
      <path d="m17.5 4.5 2.5 2.5-2.5 2.5M17.5 12.5l2.5 2.5-2.5 2.5" />
    </IconBase>
  ),
  users: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19.5v-1a5.5 5.5 0 0 1 11 0v1" />
      <path d="M15.5 5.2a3.25 3.25 0 0 1 0 5.9M17.5 13.6a5.5 5.5 0 0 1 3 4.9v1" />
    </IconBase>
  ),
  robot: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
    </IconBase>
  ),
  bubble: (props: IconProps) => (
    <IconBase {...props}>
      <path d="M12 4.5c4.7 0 8.5 3 8.5 6.75S16.7 18 12 18c-.9 0-1.77-.1-2.58-.3L5 19.5l1.3-3.2c-1.75-1.23-2.8-3-2.8-5.05C3.5 7.5 7.3 4.5 12 4.5Z" />
    </IconBase>
  ),
  more: (props: IconProps) => (
    <IconBase {...props}>
      <circle cx="5" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.75" fill="currentColor" stroke="none" />
    </IconBase>
  ),
};
