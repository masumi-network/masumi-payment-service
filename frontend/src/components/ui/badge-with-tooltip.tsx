import * as React from 'react';
import { Badge, BadgeProps } from './badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';
import { cn } from '@/lib/utils';

export interface BadgeWithTooltipProps extends BadgeProps {
  text: string;
  tooltipText: string;
}

function BadgeWithTooltip({
  text,
  tooltipText,
  className,
  ...badgeProps
}: BadgeWithTooltipProps) {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge 
            {...badgeProps} 
            className={cn(
              'text-muted-foreground hover:text-foreground cursor-help transition-colors',
              className
            )}
          >
            {text}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm p-3">
          <p className="text-sm">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { BadgeWithTooltip };
