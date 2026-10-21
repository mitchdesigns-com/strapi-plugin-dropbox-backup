import React from 'react';

/**
 * Inline rather than from @strapi/icons: the admin build only aliases a fixed
 * list of packages for pnpm's strict isolation, and @strapi/icons is not on it,
 * so importing from it would fail to resolve inside a local plugin chunk.
 */
const BackupIcon = (props) => (
  <svg
    width="1.6rem"
    height="1.6rem"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable="false"
    {...props}
  >
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 11v6c0 1.66 3.58 3 8 3 1.3 0 2.53-.12 3.6-.33" />
    <path d="M18 14v7" />
    <path d="M15 18l3 3 3-3" />
  </svg>
);

export default BackupIcon;
