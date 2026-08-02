import { useMemo } from 'react';
import type { ClipSettings } from '../types/clip.ts';

/** Category, theme and daemon updates must not trigger another extraction. */
export const useClipSettings = ({
  bulletListMarker,
  codeBlockStyle,
  fence,
  headingStyle,
  hr,
  includeImages,
  linkStyle,
}: ClipSettings): ClipSettings =>
  useMemo(
    () => ({
      bulletListMarker,
      codeBlockStyle,
      fence,
      headingStyle,
      hr,
      includeImages,
      linkStyle,
    }),
    [bulletListMarker, codeBlockStyle, fence, headingStyle, hr, includeImages, linkStyle],
  );
