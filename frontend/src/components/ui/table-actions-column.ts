/** Sticky trailing column so row actions stay visible during horizontal scroll. */
// Pin actions only when the table container is at least 32rem wide.
const tableActionsSticky = '@lg/table-scroll:sticky right-0 z-10';

/** Match masumi-saas table actions column (agents-table, x402-table-ui). */
const tableActionsGradient = 'bg-gradient-to-r from-transparent via-background/80 to-background';

const tableActionsHeadTypography =
  'text-right text-sm font-medium text-muted-foreground whitespace-nowrap';

const tableActionsCellBase = `${tableActionsSticky} ${tableActionsGradient}`;

export const tableActionsHeadClass = `${tableActionsCellBase} w-48 min-w-48 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellClass = `${tableActionsCellBase} w-48 min-w-48 p-4 pr-4`;

/** Right-align row actions to match the Actions column header. */
export const tableActionsInnerClass = 'flex items-center justify-end gap-1 min-h-8';

const tableActionsCellCompactSizing = 'w-28 min-w-28 p-4 pr-4';

export const tableActionsHeadCompactClass = `${tableActionsCellBase} ${tableActionsCellCompactSizing} ${tableActionsHeadTypography}`;

export const tableActionsCellCompactClass = `${tableActionsCellBase} ${tableActionsCellCompactSizing}`;

/** @deprecated Same gradient as default; kept for call sites that branch on row state. */
export const tableActionsCellCompactDestructiveClass = tableActionsCellCompactClass;

/** @deprecated Same gradient as default; kept for call sites that branch on row state. */
export const tableActionsCellCompactSelectedClass = tableActionsCellCompactClass;

/** @deprecated Same gradient as default; row tint shows through the transparent edge. */
export const tableActionsCellCompactLowBalanceHoverClass = '';

export const tableActionsHeadWideClass = `${tableActionsCellBase} w-64 min-w-64 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellWideClass = `${tableActionsCellBase} w-64 min-w-64 p-4 pr-4 text-right`;

/** @deprecated Same gradient as default. */
export const tableActionsCellWideDestructiveClass = tableActionsCellWideClass;
