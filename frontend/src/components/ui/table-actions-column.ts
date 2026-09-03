/** Sticky trailing column so row actions stay visible during horizontal scroll. */
const tableActionsSticky = 'sticky right-0 z-10';

const tableActionsGradientDefault =
  'bg-[linear-gradient(to_right,transparent_0%,hsl(var(--background)/0.85)_14%,hsl(var(--background))_32%,hsl(var(--background))_100%)]';

const tableActionsGradientDestructive =
  'bg-[linear-gradient(to_right,transparent_0%,var(--table-actions-destructive-row-fade)_14%,var(--table-actions-destructive-row-fill)_32%,var(--table-actions-destructive-row-fill)_100%)]';

const tableActionsGradientHover =
  'group-hover:bg-[linear-gradient(to_right,transparent_0%,var(--table-actions-row-hover-fade)_14%,var(--table-actions-row-hover-fill)_32%,var(--table-actions-row-hover-fill)_100%)]';

const tableActionsHeadTypography =
  'text-right text-sm font-medium text-muted-foreground whitespace-nowrap';

/** Fade zone passes clicks through; action controls stay interactive. */
const tableActionsCellInteraction = 'pointer-events-none [&>*]:pointer-events-auto';

const tableActionsCellShared = `${tableActionsSticky} ${tableActionsGradientDefault} ${tableActionsGradientHover} transition-[background] duration-150 ${tableActionsCellInteraction}`;

export const tableActionsHeadClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-48 min-w-48 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellClass = `${tableActionsCellShared} w-48 min-w-48 p-4 pr-4`;

export const tableActionsHeadCompactClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-28 min-w-28 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellCompactClass = `${tableActionsCellShared} w-28 min-w-28 p-4 pr-4`;

export const tableActionsCellCompactLowBalanceHoverClass =
  'group-hover:!bg-[linear-gradient(to_right,transparent_0%,var(--table-actions-low-balance-hover-fade)_14%,var(--table-actions-low-balance-hover-fill)_32%,var(--table-actions-low-balance-hover-fill)_100%)]';

export const tableActionsHeadWideClass = `${tableActionsSticky} ${tableActionsGradientDefault} w-64 min-w-64 p-4 pr-4 ${tableActionsHeadTypography}`;

export const tableActionsCellWideClass = `${tableActionsCellShared} w-64 min-w-64 p-4 pr-4`;

export const tableActionsCellWideDestructiveClass = `${tableActionsSticky} ${tableActionsGradientDestructive} ${tableActionsGradientHover} transition-[background] duration-150 ${tableActionsCellInteraction} w-64 min-w-64 p-4 pr-4`;
