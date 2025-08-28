import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { deleteApiKey } from '@/lib/api/generated';

interface DeleteApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  apiKey: {
    id: string;
  };
}

interface ApiErrorResponse {
  status: number;
  data: {
    error: {
      code: string;
      message: string;
    };
  };
}

export function DeleteApiKeyDialog({
  open,
  onClose,
  onSuccess,
  apiKey,
}: DeleteApiKeyDialogProps) {
  const { apiClient } = useAppContext();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!apiKey.id) return;

    try {
      setIsDeleting(true);
      setError(null);

      const response = await deleteApiKey({
        client: apiClient,
        body: {
          id: apiKey.id,
        },
      });

      if (response.error) {
        const error = response.error as { message: string };
        setError(error.message || 'Failed to delete API key');
        return;
      }

      await onSuccess();
      onClose();
    } catch (e) {
      let message = 'An unexpected error occurred';

      if (e instanceof Error) {
        message = e.message;
      } else if (typeof e === 'object' && e !== null) {
        const apiError = e as { response?: ApiErrorResponse };
        message = apiError.response?.data?.error?.message ?? message;
      }

      setError(message);
      throw e;
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete API Key</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete this API key? This action cannot be
            undone.
          </p>

          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onClose} disabled={isDeleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
