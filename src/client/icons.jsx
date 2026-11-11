import React from 'react';
const paths = {
  sidebar: ['M3 4h18v16H3V4Z','M9 4v16','m14 9-3 3 3 3'],
  brand: ['M4 19V5l8-2 8 2v14l-8 2-8-2Z', 'M12 3v18M4 5l8 2 8-2M8 10v6m8-6v6'],
  write: ['m16 3 5 5-12 12-6 1 1-6L16 3Z', 'm13 6 5 5M4 16l4 4'],
  figure: ['M4 3v17h17', 'm7 15 4-5 4 3 5-7'],
  read: ['M12 6c-3-3-7-3-10-2v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Z', 'M12 6v15'],
  folder: ['M3 6h7l2 2h9v12H3V6Z'],
  file: ['M6 3h8l4 4v14H6V3Z', 'M14 3v5h4M9 12h6m-6 4h6'],
  data: ['M4 4h16v16H4V4Z', 'M4 9h16M4 14h16M10 4v16'],
  chevron: ['m9 5 7 7-7 7'],
  down: ['m6 9 6 6 6-6'],
  plus: ['M12 5v14M5 12h14'],
  search: ['M15 15l6 6', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  arrow: ['M4 12h15m-6-6 6 6-6 6'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  close: ['m6 6 12 12M6 18 18 6'],
  chat: ['M4 4h16v12H9l-5 5V4Z', 'M8 8h8m-8 4h5'],
  minimize: ['M5 12h14'],
  maximize: ['M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5'],
  grip: ['M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01'],
  save: ['M5 3h13l3 3v15H3V3h2Z', 'M7 3v6h10V3M7 21v-8h10v8'],
  clock: ['M12 7v5l3 2', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'],
  check: ['m5 12 4 4L20 5'],
  layers: ['m12 3 10 5-10 5L2 8l10-5Z', 'm2 13 10 5 10-5m-20 5 10 5 10-5'],
  link: ['m10 14 4-4', 'M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0'],
  settings: ['M4 7h16M4 17h16', 'M8 4v6M16 14v6'],
  upload: ['M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5'],
  trash: ['M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6'],
};
export function Icon({ name, size = 17, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{(paths[name] || paths.file).map((d, index) => <path key={index} d={d} />)}</svg>;
}
