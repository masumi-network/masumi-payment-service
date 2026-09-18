/** Sticky trailing column so row actions stay visible during horizontal scroll. */
// Pin actions only when the table container is at least 32rem wide.
const tableActionsSticky = '@lg/table-scroll:sticky right-0 z-10';

/** Match masumi-saas fade shape; sync fill with common row backgrounds (see transactions). */
const tableActionsGradientDefault =
  'bg-gradient-to-r from-transparent via-background/80 to-background group-hover:via-muted/50 group-hover:to-muted/50';

const tableActionsGradientDestructive =
  'bg-gradient-to-r from-transparent via-destructive/10 to-destructive/10 group-hover:via-muted/50 group-hover:to-muted/50';

const tableActionsGradientMuted =
  'bg-gradient-to-r from-transparent via-muted/50 to-muted/50 group-hover:via-muted/50 group-hover:to-muted/50';

const tableActionsGradientLowBalance =
  'bg-gradient-to-r from-transparent via-amber-500/10 to-amber-500/10 group-hover:via-amber-500/10 group-hover:to-amber-500/10';

const tableActionsHeadTypography =
  'text-right text-sm font-medium text-muted-foreground whitespace-nowrap';

const tableActionsCellBase = `${tableActionsSticky} ${tableActionsGradientDefault}`;

export const tableActionsHeadClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-48 min-w-48 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellClass = `${tableActionsCellBase} w-48 min-w-48 p-4 pr-4`;

/** Right-align row actions to match the Actions column header. */
export const tableActionsInnerClass = 'flex items-center justify-end gap-1 min-h-8';

const tableActionsCellCompactSizing = 'w-28 min-w-28 p-4 pr-4';

export const tableActionsHeadCompactClass = `${tableActionsSticky} ${tableActionsGradientDefault} ${tableActionsCellCompactSizing} ${tableActionsHeadTypography}`;

export const tableActionsCellCompactClass = `${tableActionsCellBase} ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactDestructiveClass = `${tableActionsSticky} ${tableActionsGradientDestructive} ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactSelectedClass = `${tableActionsSticky} ${tableActionsGradientMuted} ${tableActionsCellCompactSizing}`;

/** Pair with wallet rows using bg-amber-500/5 hover:bg-amber-500/10. */
export const tableActionsCellCompactLowBalanceClass = `${tableActionsSticky} ${tableActionsGradientLowBalance} ${tableActionsCellCompactSizing}`;

/** @deprecated Use tableActionsCellCompactLowBalanceClass on the cell instead of a hover-only override. */
export const tableActionsCellCompactLowBalanceHoverClass = '';

export const tableActionsHeadWideClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-64 min-w-64 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellWideClass = `${tableActionsCellBase} w-64 min-w-64 p-4 pr-4 text-right`;

export const tableActionsCellWideDestructiveClass = `${tableActionsSticky} ${tableActionsGradientDestructive} w-64 min-w-64 p-4 pr-4`;
