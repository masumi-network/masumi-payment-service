import { CopyButton } from '@/components/ui/copy-button';
import { useState } from 'react';
import { cn } from '@/lib/utils';

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
  // Only show curl tab by default if we have a curl command, otherwise show response
  const [activeTab, setActiveTab] = useState<'curl' | 'response'>('curl');

  // Don't render if we have nothing to show
  const hasCurl = curlCommand && curlCommand.length > 0;
  const hasResponse = response !== null && response !== undefined;
  const hasError = error !== null && error !== undefined && error.length > 0;

  if (!hasCurl && !hasResponse && !hasError) {
    return null;
  }

  return (
    <div className="mt-4 border rounded-lg overflow-hidden">
      <div className="flex border-b">
        <button
          onClick={() => setActiveTab('curl')}
          className={cn(
            'flex-1 py-2 px-4 text-sm font-medium transition-colors',
            activeTab === 'curl'
              ? 'bg-background text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Curl Command
        </button>
        <button
          onClick={() => setActiveTab('response')}
          className={cn(
            'flex-1 py-2 px-4 text-sm font-medium transition-colors',
            activeTab === 'response'
              ? 'bg-background text-foreground border-b-2 border-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Response
        </button>
      </div>

      {activeTab === 'curl' && (
        <div className="relative bg-muted rounded-b-lg">
          <div 
            className="p-4 overflow-y-auto overflow-x-auto" 
            style={{ height: '220px' }}
          >
            {hasCurl ? (
              <pre className="text-xs font-mono whitespace-pre-wrap wrap-break-word leading-relaxed pr-12">{curlCommand}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">No curl command available yet.</p>
            )}
          </div>
          {hasCurl && (
            <div className="absolute top-2 right-2 z-10 bg-muted/90 rounded p-1">
              <CopyButton value={curlCommand} />
            </div>
          )}
        </div>
      )}

      {activeTab === 'response' && (
        <div className="relative bg-muted rounded-b-lg">
          <div 
            className="p-4 overflow-y-auto overflow-x-auto" 
            style={{ height: '220px' }}
          >
            {hasError ? (
              <div className="text-destructive">
                <div className="font-semibold mb-2">Error</div>
                <pre className="font-mono text-xs whitespace-pre-wrap">{error}</pre>
              </div>
            ) : hasResponse ? (
              <pre className="text-xs font-mono whitespace-pre-wrap wrap-break-word leading-relaxed pr-12">{JSON.stringify(response, null, 2)}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                No response yet. Submit the request to see the response.
              </p>
            )}
          </div>
          {hasResponse && !hasError && (
            <div className="absolute top-2 right-2 z-10 bg-muted/90 rounded p-1">
              <CopyButton value={JSON.stringify(response, null, 2)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
