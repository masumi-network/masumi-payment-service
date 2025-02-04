import { Button } from "./button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

interface PaginationProps {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  className?: string;
}

export function Pagination({ hasMore, isLoading, onLoadMore, className = "" }: PaginationProps) {
  return (
    <div className={`flex justify-center space-x-2 ${className}`}>
      <Button
        variant="outline"
        size="sm"
        onClick={onLoadMore}
        disabled={!hasMore || isLoading}
      >
        {isLoading ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        ) : hasMore ? (
          "Load More"
        ) : (
          "No More Data"
        )}
      </Button>
    </div>
  );
} 