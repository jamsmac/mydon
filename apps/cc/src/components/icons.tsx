/** Иконки из дизайна Claude Design — один набор на всю панель. */

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  tasks: 'M9 6h12M9 12h12M9 18h12M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17',
  dec: 'M12 3 4 6v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V6zM9 12l2 2 4-4',
  team: 'M12 8m-3.2 0a3.2 3.2 0 1 0 6.4 0 3.2 3.2 0 1 0-6.4 0M6 20c0-3.3 2.7-5 6-5s6 1.7 6 5',
  agents: 'M12 2 22 12 12 22 2 12z',
  reg: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  jour: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  biz: 'M4 3h16v18H4zM9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2',
  back: 'M19 12H5M11 18l-6-6 6-6',
  edit: 'm16.5 3.5 4 4L8 20l-5 1 1-5z',
  plus: 'M12 5v14M5 12h14',
  pin: 'M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11zM12 10m-2.5 0a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  q: 'M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.9-.9 1.5v.4M12 17h.01',
  star: 'm12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z',
  redo: 'M3 12a9 9 0 1 1 3 6.7M3 20v-5h5',
  search: 'M11 11m-7 0a7 7 0 1 0 14 0 7 7 0 1 0-14 0M21 21l-4.3-4.3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  sky: 'm12 3 2 5.2 5.2 2-5.2 2-2 5.2-2-5.2-5.2-2 5.2-2zM19 16.5v3M17.5 18h3',
  spark: 'M12 3v6M12 15v6M3 12h6M15 12h6M6.4 6.4l3 3M14.6 14.6l3 3M17.6 6.4l-3 3M9.4 14.6l-3 3',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  box: 'm12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9',
};

export function Ic({ name, size }: { name: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={size ? { width: size, height: size } : undefined}
      aria-hidden
    >
      <path d={PATHS[name] ?? PATHS.box} />
    </svg>
  );
}
