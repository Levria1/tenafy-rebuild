'use client';

import { Grid } from 'antd';

/**
 * Returns { isMobile: boolean }
 * Mobile = viewport < 768px (Ant Design `md` breakpoint).
 * Defaults to false during SSR so desktop layout is rendered first.
 */
export default function useIsMobile() {
  const screens = Grid.useBreakpoint();
  // screens.md is true when viewport >= 768px
  // On SSR all values are undefined, so !undefined === true — guard with ?? false
  const isMobile = !(screens.md ?? true);
  return { isMobile };
}
