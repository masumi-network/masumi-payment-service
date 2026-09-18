/** Sticky trailing column so row actions stay visible during horizontal scroll. */
// Pin actions only when the table container is at least 32rem wide.
const tableActionsSticky = '@lg/table-scroll:sticky right-0 z-10';

const tableActionsGradientDefault =
  'bg-[linear-gradient(to_right,transparent_0%,hsl(var(--background)/0.85)_14%,hsl(var(--background))_32%,hsl(var(--background))_100%)]';

const tableActionsHeadTypography =
  'text-right text-sm font-medium text-muted-foreground whitespace-nowrap';

/** Row-synced fade lives in globals.css (`.table-actions-cell`, @property transitions). */
const tableActionsCellBase = `${tableActionsSticky} table-actions-cell`;

export const tableActionsHeadClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-48 min-w-48 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellClass = `${tableActionsCellBase} w-48 min-w-48 p-4 pr-4`;

/** Right-align row actions to match the Actions column header. */
export const tableActionsInnerClass = 'flex items-center justify-end gap-1 min-h-8';

const tableActionsCellCompactSizing = 'w-28 min-w-28 p-4 pr-4';

export const tableActionsHeadCompactClass = `${tableActionsSticky} ${tableActionsGradientDefault} ${tableActionsCellCompactSizing} ${tableActionsHeadTypography}`;

export const tableActionsCellCompactClass = `${tableActionsCellBase} ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactDestructiveClass = `${tableActionsCellBase} table-actions-cell--destructive ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactSelectedClass = `${tableActionsCellBase} table-actions-cell--selected ${tableActionsCellCompactSizing}`;

export const tableActionsCellCompactLowBalanceHoverClass =
  'group-hover:!bg-[linear-gradient(to_right,transparent_0%,var(--table-actions-low-balance-hover-fade)_14%,var(--table-actions-low-balance-hover-fill)_32%,var(--table-actions-low-balance-hover-fill)_100%)]';

export const tableActionsHeadWideClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-64 min-w-64 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellWideClass = `${tableActionsCellBase} w-64 min-w-64 p-4 pr-4 text-right`;

export const tableActionsCellWideDestructiveClass = `${tableActionsCellBase} table-actions-cell--destructive w-64 min-w-64 p-4 pr-4`;
