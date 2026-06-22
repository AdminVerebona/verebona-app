/**
 * Centralized color palette for jsPDF renderers.
 *
 * jsPDF does not support CSS variables — colors must be RGB tuples.
 * All hardcoded values in the PDF renderer must reference this file.
 *
 * Semantic naming mirrors the Tailwind/CSS token names used in the UI:
 *   ink       ↔  foreground / slate-900
 *   slate     ↔  slate-600
 *   muted     ↔  muted-foreground / slate-500
 *   navy      ↔  primary brand color (cyan-800-ish)
 *   navyLight ↔  sky-50 (light tint for backgrounds)
 *   bg        ↔  slate-50 (card/section background)
 *   border    ↔  slate-200
 *   borderMid ↔  slate-300
 *   white     ↔  #FFFFFF
 *   primary   ↔  blue-500 (#3B82F6 — brand accent)
 *   green     ↔  green-600 (available/success)
 *   greenBg   ↔  green-100
 *   orange    ↔  orange-900 (partial/warning)
 *   orangeBg  ↔  orange-100
 *   yellow    ↔  amber-800 (verify/caution)
 *   yellowBg  ↔  yellow-100
 *   gray      ↔  gray-500 (missing/neutral)
 *   grayBg    ↔  gray-100
 */

export type RGB = readonly [number, number, number];

export const PDF_PALETTE = {
  // ── Text & structure ──────────────────────────────────────────────────────
  ink:       [15, 23, 42]    as RGB,   // deepest text
  slate:     [71, 85, 105]   as RGB,   // secondary text
  muted:     [100, 116, 139] as RGB,   // muted labels
  white:     [255, 255, 255] as RGB,

  // ── Brand / primary ───────────────────────────────────────────────────────
  navy:      [22, 78, 99]    as RGB,   // headings, section bars, pill borders
  navyLight: [240, 249, 255] as RGB,   // light navy tint backgrounds
  primary:   [59, 130, 246]  as RGB,   // blue-500 accent (bar, links)

  // ── Surfaces ──────────────────────────────────────────────────────────────
  pageBg:      [252, 252, 251] as RGB,   // very light off-white page background
  bg:          [255, 255, 255] as RGB,   // card/section background (pure white)
  border:      [226, 232, 240] as RGB,   // default border (slate-200)
  borderMid:   [203, 213, 225] as RGB,   // slightly stronger border (slate-300)
  placeholder: [180, 188, 200] as RGB,   // empty/missing field value — lighter than muted

  // ── Status: available ─────────────────────────────────────────────────────
  green:     [22, 163, 74]   as RGB,   // green-600
  greenBg:   [220, 252, 231] as RGB,   // green-100

  // ── Status: partial / to complete ────────────────────────────────────────
  orange:    [154, 52, 18]   as RGB,   // orange-900
  orangeBg:  [255, 237, 213] as RGB,   // orange-100

  // ── Status: to verify ─────────────────────────────────────────────────────
  yellow:    [133, 77, 14]   as RGB,   // amber-800
  yellowBg:  [254, 249, 195] as RGB,   // yellow-100

  // ── Status: missing / neutral ─────────────────────────────────────────────
  gray:      [107, 114, 128] as RGB,   // gray-500
  grayBg:    [243, 244, 246] as RGB,   // gray-100

  // ── Generic renderer legacy values ────────────────────────────────────────
  // These mirror the above but exist as explicit aliases for the generic renderer.
  blueHeader:   [59, 130, 246]  as RGB,  // primary blue header bar
  blueSection:  [239, 246, 255] as RGB,  // section title background (blue-50)
  blueSectionFg:[29, 78, 216]   as RGB,  // section title text (blue-700)
  rowFg:        [26, 26, 46]    as RGB,  // row value text
  rowLabel:     [107, 114, 128] as RGB,  // row label text
  rowMeta:      [156, 163, 175] as RGB,  // secondary meta text (gray-400)
  rowDivider:   [241, 245, 249] as RGB,  // row divider line (slate-100)
} as const;
