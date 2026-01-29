import { CopyButton } from '@/components/ui/copy-button';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';

interface CurlResponseViewerProps {
  curlCommand?: string;
  response?: object | null;
  error?: string | null;
}

export function CurlResponseViewer({
  curlCommand,
  response,
  error,
}: CurlResponseViewerProps) {
  const [curlExpanded, setCurlExpanded] = useState(false);

  const hasCurl = curlCommand && curlCommand.length > 0;
  const hasResponse = response !== null && response !== undefined;
  const hasError = error !== null && error !== undefined && error.length > 0;

  if (!hasCurl && !hasResponse && !hasError) {
    return null;
  }

  return (
    <div className="space-y-3 mt-4 animate-fade-in-up opacity-0">
      {/* Curl Command — collapsible */}
      {hasCurl && (
        <Card className="overflow-hidden transition-shadow duration-200 hover:shadow-md">
          <button
            type="button"
            onClick={() => setCurlExpanded((v) => !v)}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-150"
          >
            <span className="transition-transform duration-200">
              {curlExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
            <Terminal className="h-3.5 w-3.5" />
            cURL Command
          </button>
          {curlExpanded && (
            <div className="animate-slide-down">
              <Separator />
              <CardContent className="relative p-0">
                <div className="p-3 overflow-auto max-h-[180px] bg-muted/50">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed pr-8">
                    {curlCommand}
                  </pre>
                </div>
                <div className="absolute top-2 right-2">
                  <CopyButton value={curlCommand} />
                </div>
              </CardContent>
            </div>
          )}
        </Card>
      )}

      {/* Response — always visible */}
      {(hasResponse || hasError) && (
        <Card className="overflow-hidden animate-fade-in transition-shadow duration-200 hover:shadow-md">
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Response
              </span>
              {hasError ? (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                  Error
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  200 OK
                </Badge>
              )}
            </div>
            {hasResponse && !hasError && (
              <CopyButton value={JSON.stringify(response, null, 2)} />
            )}
          </div>
          <Separator />
          <CardContent className="p-0">
            <div className="p-3 overflow-auto max-h-[220px] bg-muted/50">
              {hasError ? (
                <pre className="font-mono text-xs whitespace-pre-wrap text-destructive">
                  {error}
                </pre>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
                  {JSON.stringify(response, null, 2)}
                </pre>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
