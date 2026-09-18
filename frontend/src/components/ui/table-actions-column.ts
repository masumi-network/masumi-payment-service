/** Sticky trailing column so row actions stay visible during horizontal scroll. */
// Pin actions only when the table container is at least 32rem wide.
const tableActionsSticky = '@lg/table-scroll:sticky right-0 z-10';

const tableActionsHeadFill = 'table-actions-head-fill';
const tableActionsCellFill = 'table-actions-cell-fill';

const tableActionsHeadTypography =
  'text-right text-sm font-medium text-muted-foreground whitespace-nowrap';

const tableActionsCellBase = `${tableActionsSticky} ${tableActionsCellFill}`;

export const tableActionsHeadClass = `${tableActionsSticky} ${tableActionsHeadFill} w-48 min-w-48 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellClass = `${tableActionsCellBase} w-48 min-w-48 p-4 pr-4`;

/** Right-align row actions to match the Actions column header. */
export const tableActionsInnerClass = 'flex items-center justify-end gap-1 min-h-8';

const tableActionsCellCompactSizing = 'w-28 min-w-28 p-4 pr-4';

export const tableActionsHeadCompactClass = `${tableActionsSticky} ${tableActionsHeadFill} ${tableActionsCellCompactSizing} ${tableActionsHeadTypography}`;

export const tableActionsCellCompactClass = `${tableActionsCellBase} ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactDestructiveClass = `${tableActionsSticky} ${tableActionsCellFill} table-actions-cell-fill--destructive ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactSelectedClass = `${tableActionsSticky} ${tableActionsCellFill} table-actions-cell-fill--highlight ${tableActionsCellCompactSizing}`;

/** Pair with wallet rows using bg-amber-500/5 hover:bg-amber-500/10. */
export const tableActionsCellCompactLowBalanceClass = `${tableActionsSticky} ${tableActionsCellFill} table-actions-cell-fill--low-balance ${tableActionsCellCompactSizing}`;

/** @deprecated Use tableActionsCellCompactLowBalanceClass on the cell instead of a hover-only override. */
export const tableActionsCellCompactLowBalanceHoverClass = '';

export const tableActionsHeadWideClass = `${tableActionsSticky} ${tableActionsHeadFill} w-64 min-w-64 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellWideClass = `${tableActionsCellBase} w-64 min-w-64 p-4 pr-4 text-right`;

export const tableActionsCellWideDestructiveClass = `${tableActionsSticky} ${tableActionsCellFill} table-actions-cell-fill--destructive w-64 min-w-64 p-4 pr-4`;
