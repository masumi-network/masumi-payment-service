import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'react-toastify';
import { Info, CheckCheck } from 'lucide-react';
import { patchWebhooks, postWebhooks } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { extractApiErrorMessage } from '@/lib/api-error';
import { handleApiCall } from '@/lib/utils';
import {
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENTS,
  WEBHOOK_FORMAT_LABELS,
  WEBHOOK_FORMATS,
  type WebhookEvent,
  type WebhookFormat,
  type WebhookRecord,
} from '@/lib/webhooks';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface WebhookDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  paymentSourceId: string;
  webhook?: WebhookRecord | null;
  onClose: () => void;
  onSuccess: () => void;
}

const webhookFormSchema = z
  .object({
    name: z.string().max(120, 'Name must be 120 characters or fewer'),
    format: z.enum(WEBHOOK_FORMATS),
    url: z.string().trim().url('Enter a valid webhook URL'),
    authToken: z.string(),
    Events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Select at least one event'),
  })
  .superRefine((value, ctx) => {
    if (value.format === 'EXTENDED' && !value.authToken.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Auth token is required for extended webhooks',
        path: ['authToken'],
      });
    }
  });

type WebhookFormValues = z.infer<typeof webhookFormSchema>;

const formatGuidance: Record<
  WebhookFormat,
  {
    title: string;
    description: string;
    detail: string;
  }
> = {
  EXTENDED: {
    title: 'Extended endpoint',
    description: 'Use your own endpoint URL and Masumi will POST the extended JSON payload to it.',
    detail:
      'Masumi sends Authorization: Bearer <auth token> plus the Masumi event headers. Keep this token secret and verify it server-side.',
  },
  SLACK: {
    title: 'Slack incoming webhook',
    description: 'Paste the full Slack incoming webhook URL for the target channel.',
    detail:
      'No extra auth field is needed here. Masumi will format the message for Slack automatically.',
  },
  GOOGLE_CHAT: {
    title: 'Google Chat webhook',
    description: 'Paste the full Google Chat incoming webhook URL for the destination space.',
    detail:
      'No extra auth field is needed here. Masumi will send a compact Chat-friendly text payload.',
  },
  DISCORD: {
    title: 'Discord webhook',
    description: 'Paste the full Discord webhook URL for the destination channel.',
    detail:
      'No extra auth field is needed here. Masumi will send a compact Discord message payload.',
  },
};

function getDefaultValues(webhook?: WebhookRecord | null): WebhookFormValues {
  return {
    name: webhook?.name ?? '',
    format: webhook?.format ?? 'EXTENDED',
    url: webhook?.url ?? '',
    authToken: '',
    Events: webhook?.Events ?? [...WEBHOOK_EVENTS],
  };
}

export function WebhookDialog({
  open,
  mode,
  paymentSourceId,
  webhook,
  onClose,
  onSuccess,
}: WebhookDialogProps) {
  const { apiClient } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    control,
    formState: { errors },
    handleSubmit,
    register,
    reset,
    setValue,
  } = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookFormSchema),
    defaultValues: getDefaultValues(webhook),
  });

  useEffect(() => {
    if (open) {
      reset(getDefaultValues(webhook));
    }
  }, [open, reset, webhook]);

  const selectedFormat = useWatch({
    control,
    name: 'format',
    defaultValue: webhook?.format ?? 'EXTENDED',
  });
  const selectedEvents = useWatch({
    control,
    name: 'Events',
    defaultValue: webhook?.Events ?? [...WEBHOOK_EVENTS],
  });

  const allEventsSelected = selectedEvents.length === WEBHOOK_EVENTS.length;
  const guidance = formatGuidance[selectedFormat];
  const dialogTitle = mode === 'create' ? 'Add webhook' : 'Edit webhook';
  const dialogDescription =
    mode === 'create'
      ? 'Create a webhook for the currently selected payment source.'
      : 'Update the webhook settings for the currently selected payment source.';

  const sortedSelectedEvents = useMemo(
    () => WEBHOOK_EVENTS.filter((event) => selectedEvents.includes(event)),
    [selectedEvents],
  );

  const toggleEvent = (event: WebhookEvent) => {
    const nextEvents = selectedEvents.includes(event)
      ? selectedEvents.filter((value) => value !== event)
      : [...selectedEvents, event];

    setValue(
      'Events',
      WEBHOOK_EVENTS.filter((value) => nextEvents.includes(value)),
      { shouldValidate: true },
    );
  };

  const toggleAllEvents = (checked: boolean) => {
    setValue('Events', checked ? [...WEBHOOK_EVENTS] : [], { shouldValidate: true });
  };

  const submit = async (values: WebhookFormValues) => {
    setIsSubmitting(true);

    const payload = {
      name: values.name.trim() || undefined,
      format: values.format,
      url: values.url.trim(),
      authToken: values.format === 'EXTENDED' ? values.authToken.trim() : undefined,
      Events: values.Events,
    };

    await handleApiCall(
      async () => {
        if (mode === 'create') {
          return postWebhooks({
            client: apiClient,
            body: {
              ...payload,
              paymentSourceId,
            },
          });
        }

        return patchWebhooks({
          client: apiClient,
          body: {
            webhookId: webhook!.id,
            ...payload,
          },
        });
      },
      {
        onSuccess: () => {
          toast.success(
            mode === 'create' ? 'Webhook created successfully' : 'Webhook updated successfully',
          );
          onSuccess();
          onClose();
        },
        onError: (error: unknown) => {
          console.error(`Failed to ${mode} webhook:`, error);
          toast.error(
            extractApiErrorMessage(
              error,
              mode === 'create' ? 'Failed to create webhook' : 'Failed to update webhook',
            ),
          );
        },
        onFinally: () => {
          setIsSubmitting(false);
        },
        errorMessage: mode === 'create' ? 'Failed to create webhook' : 'Failed to update webhook',
      },
    );
  };

  const handleDialogChange = (nextOpen: boolean) => {
    if (!nextOpen && !isSubmitting) {
      reset(getDefaultValues(webhook));
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(submit)} className="space-y-6">
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-background p-2 shadow-sm">
                <Info className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{guidance.title}</p>
                  <Badge variant="outline">{WEBHOOK_FORMAT_LABELS[selectedFormat]}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{guidance.description}</p>
                <p className="text-xs text-muted-foreground/80">{guidance.detail}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="webhook-name">Name</Label>
              <Input
                id="webhook-name"
                placeholder="Ops alerts"
                {...register('name')}
                disabled={isSubmitting}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhook-format">Format</Label>
              <Controller
                control={control}
                name="format"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value as WebhookFormat)}
                    disabled={isSubmitting}
                  >
                    <SelectTrigger id="webhook-format">
                      <SelectValue placeholder="Select a format" />
                    </SelectTrigger>
                    <SelectContent>
                      {WEBHOOK_FORMATS.map((format) => (
                        <SelectItem key={format} value={format}>
                          {WEBHOOK_FORMAT_LABELS[format]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.format && <p className="text-xs text-destructive">{errors.format.message}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="webhook-url">Webhook URL</Label>
            <Input
              id="webhook-url"
              placeholder="https://hooks.slack.com/services/..."
              {...register('url')}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              {selectedFormat === 'EXTENDED'
                ? 'Use your own HTTPS endpoint that can receive Masumi webhook payloads.'
                : 'Paste the full incoming webhook URL from the target chat service.'}
            </p>
            {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
          </div>

          {selectedFormat === 'EXTENDED' && (
            <div className="space-y-2">
              <Label htmlFor="webhook-auth-token">Auth token</Label>
              <Input
                id="webhook-auth-token"
                type="password"
                placeholder="shared-secret"
                {...register('authToken')}
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground">
                Masumi will send this value as a Bearer token so your endpoint can verify the
                request.
              </p>
              {errors.authToken && (
                <p className="text-xs text-destructive">{errors.authToken.message}</p>
              )}
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Events</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Choose all events or build a custom event set for this webhook.
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                <Checkbox
                  checked={allEventsSelected}
                  onCheckedChange={(checked) => toggleAllEvents(Boolean(checked))}
                  disabled={isSubmitting}
                />
                All events
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((event) => {
                const isSelected = selectedEvents.includes(event);

                return (
                  <Button
                    key={event}
                    type="button"
                    variant={isSelected ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => toggleEvent(event)}
                    disabled={isSubmitting}
                    className="justify-start"
                  >
                    {isSelected && <CheckCheck className="h-3.5 w-3.5" />}
                    {WEBHOOK_EVENT_LABELS[event]}
                  </Button>
                );
              })}
            </div>

            <div className="rounded-md border border-dashed bg-muted/15 p-3">
              <p className="text-xs font-medium text-muted-foreground">Selected events</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sortedSelectedEvents.length > 0 ? (
                  sortedSelectedEvents.map((event) => (
                    <Badge key={event} variant="secondary">
                      {WEBHOOK_EVENT_LABELS[event]}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">No events selected yet.</span>
                )}
              </div>
            </div>

            {errors.Events && <p className="text-xs text-destructive">{errors.Events.message}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? mode === 'create'
                  ? 'Creating...'
                  : 'Saving...'
                : mode === 'create'
                  ? 'Create webhook'
                  : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
