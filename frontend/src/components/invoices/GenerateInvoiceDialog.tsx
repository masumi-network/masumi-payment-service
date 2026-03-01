import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { ChevronDown } from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postInvoiceMonthlyAdmin } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

const currencies = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'aed'] as const;
const languages = ['en-us', 'en-uk', 'de'] as const;

const formSchema = z.object({
  buyerWalletVkey: z.string().min(1, 'Required'),
  month: z.string().min(1, 'Required'),
  invoiceCurrency: z.enum(currencies),
  vatRate: z.number().min(0).max(1).optional(),
  reverseCharge: z.boolean().optional(),
  forceRegenerate: z.boolean().optional(),
  seller: z.object({
    name: z.string().nullable().optional(),
    companyName: z.string().nullable().optional(),
    vatNumber: z.string().nullable().optional(),
    country: z.string().min(1, 'Required'),
    city: z.string().min(1, 'Required'),
    zipCode: z.string().min(1, 'Required'),
    street: z.string().min(1, 'Required'),
    streetNumber: z.string().min(1, 'Required'),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  }),
  buyer: z.object({
    name: z.string().nullable().optional(),
    companyName: z.string().nullable().optional(),
    vatNumber: z.string().nullable().optional(),
    country: z.string().min(1, 'Required'),
    city: z.string().min(1, 'Required'),
    zipCode: z.string().min(1, 'Required'),
    street: z.string().min(1, 'Required'),
    streetNumber: z.string().min(1, 'Required'),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  }),
  invoice: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      idPrefix: z.string().optional(),
      date: z.string().optional(),
      language: z.enum(languages).optional(),
      localizationFormat: z.enum(languages).optional(),
    })
    .optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface GenerateInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  prefillBuyerWalletVkey?: string;
  prefillMonth?: string;
}

function downloadBase64Pdf(base64: string, filename: string) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function AddressFields({
  prefix,
  register,
  errors,
}: {
  prefix: 'seller' | 'buyer';
  register: ReturnType<typeof useForm<FormValues>>['register'];
  errors: Record<string, any>;
}) {
  const fieldErrors = errors[prefix] || {};
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label htmlFor={`${prefix}.name`}>Name</Label>
        <Input id={`${prefix}.name`} {...register(`${prefix}.name`)} placeholder="Name" />
      </div>
      <div>
        <Label htmlFor={`${prefix}.companyName`}>Company Name</Label>
        <Input
          id={`${prefix}.companyName`}
          {...register(`${prefix}.companyName`)}
          placeholder="Company"
        />
      </div>
      <div>
        <Label htmlFor={`${prefix}.vatNumber`}>VAT Number</Label>
        <Input
          id={`${prefix}.vatNumber`}
          {...register(`${prefix}.vatNumber`)}
          placeholder="VAT ID"
        />
      </div>
      <div>
        <Label htmlFor={`${prefix}.country`}>
          Country <span className="text-destructive">*</span>
        </Label>
        <Input id={`${prefix}.country`} {...register(`${prefix}.country`)} placeholder="Country" />
        {fieldErrors.country && (
          <p className="text-xs text-destructive mt-1">{fieldErrors.country.message}</p>
        )}
      </div>
      <div>
        <Label htmlFor={`${prefix}.city`}>
          City <span className="text-destructive">*</span>
        </Label>
        <Input id={`${prefix}.city`} {...register(`${prefix}.city`)} placeholder="City" />
        {fieldErrors.city && (
          <p className="text-xs text-destructive mt-1">{fieldErrors.city.message}</p>
        )}
      </div>
      <div>
        <Label htmlFor={`${prefix}.zipCode`}>
          Zip Code <span className="text-destructive">*</span>
        </Label>
        <Input id={`${prefix}.zipCode`} {...register(`${prefix}.zipCode`)} placeholder="Zip" />
        {fieldErrors.zipCode && (
          <p className="text-xs text-destructive mt-1">{fieldErrors.zipCode.message}</p>
        )}
      </div>
      <div>
        <Label htmlFor={`${prefix}.street`}>
          Street <span className="text-destructive">*</span>
        </Label>
        <Input id={`${prefix}.street`} {...register(`${prefix}.street`)} placeholder="Street" />
        {fieldErrors.street && (
          <p className="text-xs text-destructive mt-1">{fieldErrors.street.message}</p>
        )}
      </div>
      <div>
        <Label htmlFor={`${prefix}.streetNumber`}>
          Street Number <span className="text-destructive">*</span>
        </Label>
        <Input
          id={`${prefix}.streetNumber`}
          {...register(`${prefix}.streetNumber`)}
          placeholder="No."
        />
        {fieldErrors.streetNumber && (
          <p className="text-xs text-destructive mt-1">{fieldErrors.streetNumber.message}</p>
        )}
      </div>
      <div>
        <Label htmlFor={`${prefix}.email`}>Email</Label>
        <Input
          id={`${prefix}.email`}
          {...register(`${prefix}.email`)}
          placeholder="email@example.com"
          type="email"
        />
      </div>
      <div>
        <Label htmlFor={`${prefix}.phone`}>Phone</Label>
        <Input id={`${prefix}.phone`} {...register(`${prefix}.phone`)} placeholder="Phone" />
      </div>
    </div>
  );
}

export function GenerateInvoiceDialog({
  open,
  onClose,
  onSuccess,
  prefillBuyerWalletVkey,
  prefillMonth,
}: GenerateInvoiceDialogProps) {
  const { apiClient } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      buyerWalletVkey: prefillBuyerWalletVkey || '',
      month: prefillMonth || '',
      invoiceCurrency: 'usd',
      vatRate: 0,
      reverseCharge: false,
      forceRegenerate: false,
      seller: {
        name: null,
        companyName: null,
        vatNumber: null,
        country: '',
        city: '',
        zipCode: '',
        street: '',
        streetNumber: '',
        email: null,
        phone: null,
      },
      buyer: {
        name: null,
        companyName: null,
        vatNumber: null,
        country: '',
        city: '',
        zipCode: '',
        street: '',
        streetNumber: '',
        email: null,
        phone: null,
      },
      invoice: {},
    },
  });

  const reverseCharge = watch('reverseCharge');
  const forceRegenerate = watch('forceRegenerate');
  const invoiceCurrency = watch('invoiceCurrency');

  const onSubmit = async (data: FormValues) => {
    setIsSubmitting(true);
    const result = await handleApiCall(
      () =>
        postInvoiceMonthlyAdmin({
          client: apiClient,
          body: {
            buyerWalletVkey: data.buyerWalletVkey,
            month: data.month,
            invoiceCurrency: data.invoiceCurrency,
            vatRate: data.vatRate,
            reverseCharge: data.reverseCharge,
            forceRegenerate: data.forceRegenerate,
            seller: {
              country: data.seller.country,
              city: data.seller.city,
              zipCode: data.seller.zipCode,
              street: data.seller.street,
              streetNumber: data.seller.streetNumber,
              email: data.seller.email ?? null,
              phone: data.seller.phone ?? null,
              name: data.seller.name ?? null,
              companyName: data.seller.companyName ?? null,
              vatNumber: data.seller.vatNumber ?? null,
            },
            buyer: {
              country: data.buyer.country,
              city: data.buyer.city,
              zipCode: data.buyer.zipCode,
              street: data.buyer.street,
              streetNumber: data.buyer.streetNumber,
              email: data.buyer.email ?? null,
              phone: data.buyer.phone ?? null,
              name: data.buyer.name ?? null,
              companyName: data.buyer.companyName ?? null,
              vatNumber: data.buyer.vatNumber ?? null,
            },
            invoice: data.invoice,
          },
        }),
      { errorMessage: 'Failed to generate invoice' },
    );
    setIsSubmitting(false);

    if (result?.data?.data) {
      toast.success('Invoice generated successfully');
      if (result.data.data.invoice) {
        downloadBase64Pdf(
          result.data.data.invoice,
          `invoice-${data.month}-${data.buyerWalletVkey.slice(0, 8)}.pdf`,
        );
      }
      if (result.data.data.cancellationInvoice) {
        downloadBase64Pdf(
          result.data.data.cancellationInvoice,
          `cancellation-invoice-${data.month}-${data.buyerWalletVkey.slice(0, 8)}.pdf`,
        );
      }
      reset();
      onSuccess();
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate Invoice</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Core Fields */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="buyerWalletVkey">
                Buyer Wallet VKey <span className="text-destructive">*</span>
              </Label>
              <Input
                id="buyerWalletVkey"
                {...register('buyerWalletVkey')}
                placeholder="Buyer wallet verification key"
                className="font-mono text-sm"
              />
              {errors.buyerWalletVkey && (
                <p className="text-xs text-destructive mt-1">{errors.buyerWalletVkey.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="month">
                Month <span className="text-destructive">*</span>
              </Label>
              <Input id="month" type="month" {...register('month')} />
              {errors.month && (
                <p className="text-xs text-destructive mt-1">{errors.month.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="invoiceCurrency">
                Currency <span className="text-destructive">*</span>
              </Label>
              <Select
                value={invoiceCurrency}
                onValueChange={(val) =>
                  setValue('invoiceCurrency', val as (typeof currencies)[number])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="vatRate">VAT Rate (decimal)</Label>
              <Input
                id="vatRate"
                type="number"
                step="0.01"
                min="0"
                max="1"
                {...register('vatRate', { valueAsNumber: true })}
                placeholder="0.19"
              />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  checked={reverseCharge || false}
                  onCheckedChange={(checked) => setValue('reverseCharge', checked)}
                />
                <Label>Reverse Charge</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={forceRegenerate || false}
                  onCheckedChange={(checked) => setValue('forceRegenerate', checked)}
                />
                <Label>Force Regenerate</Label>
              </div>
            </div>
          </div>

          <Separator />

          {/* Seller Details */}
          <div>
            <h4 className="text-sm font-medium mb-3">Seller Details</h4>
            <AddressFields prefix="seller" register={register} errors={errors} />
          </div>

          <Separator />

          {/* Buyer Details */}
          <div>
            <h4 className="text-sm font-medium mb-3">Buyer Details</h4>
            <AddressFields prefix="buyer" register={register} errors={errors} />
          </div>

          <Separator />

          {/* Invoice Options (collapsible) */}
          <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" type="button" className="w-full justify-between px-0">
                <span className="text-sm font-medium">Invoice Options</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${optionsOpen ? 'rotate-180' : ''}`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <Label htmlFor="invoice.title">Title</Label>
                  <Input
                    id="invoice.title"
                    {...register('invoice.title')}
                    placeholder="Invoice title"
                  />
                </div>
                <div>
                  <Label htmlFor="invoice.description">Description</Label>
                  <Input
                    id="invoice.description"
                    {...register('invoice.description')}
                    placeholder="Description"
                  />
                </div>
                <div>
                  <Label htmlFor="invoice.idPrefix">ID Prefix</Label>
                  <Input
                    id="invoice.idPrefix"
                    {...register('invoice.idPrefix')}
                    placeholder="INV-"
                  />
                </div>
                <div>
                  <Label htmlFor="invoice.date">Date</Label>
                  <Input
                    id="invoice.date"
                    {...register('invoice.date')}
                    placeholder="YYYY-MM-DD"
                    type="date"
                  />
                </div>
                <div>
                  <Label htmlFor="invoice.language">Language</Label>
                  <Select
                    value={watch('invoice.language') || ''}
                    onValueChange={(val) =>
                      setValue('invoice.language', val as (typeof languages)[number])
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Default (en-us)" />
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="invoice.localizationFormat">Localization Format</Label>
                  <Select
                    value={watch('invoice.localizationFormat') || ''}
                    onValueChange={(val) =>
                      setValue('invoice.localizationFormat', val as (typeof languages)[number])
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Default (en-us)" />
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Spinner size={16} />
                  Generating...
                </>
              ) : (
                'Generate Invoice'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
