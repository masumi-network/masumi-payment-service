import * as React from 'react';
import { Badge, BadgeProps } from './badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

export interface BadgeWithTooltipProps extends BadgeProps {
  text: string;
  tooltipText: string;
}

function BadgeWithTooltip({
  text,
  tooltipText,
  ...badgeProps
}: BadgeWithTooltipProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge {...badgeProps}>{text}</Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { BadgeWithTooltip };
