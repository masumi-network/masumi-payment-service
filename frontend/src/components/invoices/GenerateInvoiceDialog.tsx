import { useState, useEffect, useCallback } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
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
import { ChevronDown, Save, Trash2, Pencil } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postInvoiceMonthlyAdmin } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';
import { useSellerTemplates, type SellerTemplateData } from '@/lib/hooks/useSellerTemplates';
import { extractApiErrorMessage, mapInvoiceApiErrorMessage } from '@/lib/api-error';
import { downloadBase64Pdf } from '@/lib/pdf-utils';

const currencies = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'aed'] as const;
const languages = ['en-us', 'en-gb', 'de'] as const;

const EMPTY_SELLER: SellerTemplateData = {
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
};

const formSchema = z
  .object({
    buyerWalletVkey: z
      .string()
      .min(1, 'Required')
      .regex(/^[0-9a-fA-F]+$/, 'Must be hex'),
    month: z.string().min(1, 'Required'),
    invoiceCurrency: z.enum(currencies),
    vatRate: z.number().min(0, 'Min 0').max(1, 'Max 1').optional(),
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
      email: z.string().email('Invalid email').nullable().optional().or(z.literal('')),
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
      email: z.string().email('Invalid email').nullable().optional().or(z.literal('')),
      phone: z.string().nullable().optional(),
    }),
    invoice: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        idPrefix: z.string().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
          .or(z.literal(''))
          .optional(),
        language: z.enum(languages).optional(),
        localizationFormat: z.enum(languages).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const reverseCharge = value.reverseCharge ?? false;
    const vatRate = value.vatRate ?? 0;
    const sellerVat = value.seller.vatNumber?.trim() ?? '';
    const buyerVat = value.buyer.vatNumber?.trim() ?? '';

    if ((vatRate > 0 || reverseCharge) && sellerVat.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seller', 'vatNumber'],
        message: 'Seller VAT number is required when VAT is applied or reverse charge is enabled.',
      });
    }

    if (reverseCharge && buyerVat.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buyer', 'vatNumber'],
        message: 'Buyer VAT number is required when reverse charge is enabled.',
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

interface GenerateInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  prefillBuyerWalletVkey: string;
  prefillMonth: string;
  prefillForceRegenerate?: boolean;
  formatMonth: (month: string) => string;
}

function AddressFields({
  prefix,
  register,
  errors,
}: {
  prefix: 'seller' | 'buyer';
  register: ReturnType<typeof useForm<FormValues>>['register'];
  errors: FieldErrors<FormValues>;
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
        {fieldErrors.vatNumber && (
          <p className="text-xs text-destructive mt-1">{fieldErrors.vatNumber.message}</p>
        )}
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
  prefillForceRegenerate = false,
  formatMonth,
}: GenerateInvoiceDialogProps) {
  const { apiClient } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const {
    templates,
    save: saveTemplate,
    update: updateTemplate,
    remove: removeTemplate,
  } = useSellerTemplates();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [isNaming, setIsNaming] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    getValues,
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
      forceRegenerate: prefillForceRegenerate,
      seller: { ...EMPTY_SELLER },
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

  useEffect(() => {
    if (open) {
      reset({
        buyerWalletVkey: prefillBuyerWalletVkey,
        month: prefillMonth,
        invoiceCurrency: 'usd',
        vatRate: 0,
        reverseCharge: false,
        forceRegenerate: prefillForceRegenerate,
        seller: { ...EMPTY_SELLER },
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
      });
      setSelectedTemplateId(null);
      setIsNaming(false);
      setIsEditing(false);
      setTemplateNameInput('');
      setSubmitError(null);
    }
  }, [open, prefillBuyerWalletVkey, prefillMonth, prefillForceRegenerate, reset]);

  const reverseCharge = watch('reverseCharge');
  const forceRegenerate = watch('forceRegenerate');
  const invoiceCurrency = watch('invoiceCurrency');
  const vatRate = watch('vatRate');

  const applyTemplate = useCallback(
    (templateId: string) => {
      const tpl = templates.find((t) => t.id === templateId);
      if (!tpl) return;
      setSelectedTemplateId(templateId);
      setIsNaming(false);
      setIsEditing(false);
      const s = tpl.seller;
      setValue('seller.name', s.name);
      setValue('seller.companyName', s.companyName);
      setValue('seller.vatNumber', s.vatNumber);
      setValue('seller.country', s.country);
      setValue('seller.city', s.city);
      setValue('seller.zipCode', s.zipCode);
      setValue('seller.street', s.street);
      setValue('seller.streetNumber', s.streetNumber);
      setValue('seller.email', s.email);
      setValue('seller.phone', s.phone);
    },
    [templates, setValue],
  );

  const clearTemplate = useCallback(() => {
    setSelectedTemplateId(null);
    setIsNaming(false);
    setIsEditing(false);
    const s = EMPTY_SELLER;
    setValue('seller.name', s.name);
    setValue('seller.companyName', s.companyName);
    setValue('seller.vatNumber', s.vatNumber);
    setValue('seller.country', s.country);
    setValue('seller.city', s.city);
    setValue('seller.zipCode', s.zipCode);
    setValue('seller.street', s.street);
    setValue('seller.streetNumber', s.streetNumber);
    setValue('seller.email', s.email);
    setValue('seller.phone', s.phone);
  }, [setValue]);

  const getCurrentSellerData = useCallback((): SellerTemplateData => {
    const v = getValues('seller');
    return {
      name: v.name ?? null,
      companyName: v.companyName ?? null,
      vatNumber: v.vatNumber ?? null,
      country: v.country,
      city: v.city,
      zipCode: v.zipCode,
      street: v.street,
      streetNumber: v.streetNumber,
      email: v.email ?? null,
      phone: v.phone ?? null,
    };
  }, [getValues]);

  const handleSaveTemplate = useCallback(() => {
    const name = templateNameInput.trim();
    if (!name) return;
    const data = getCurrentSellerData();
    const tpl = saveTemplate(name, data);
    setSelectedTemplateId(tpl.id);
    setIsNaming(false);
    setTemplateNameInput('');
    toast.success(`Template "${name}" saved`);
  }, [templateNameInput, getCurrentSellerData, saveTemplate]);

  const handleUpdateTemplate = useCallback(() => {
    if (!selectedTemplateId) return;
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl) return;
    const label = templateNameInput.trim() || tpl.label;
    const data = getCurrentSellerData();
    updateTemplate(selectedTemplateId, label, data);
    setIsEditing(false);
    setTemplateNameInput('');
    toast.success(`Template "${label}" updated`);
  }, [selectedTemplateId, templateNameInput, templates, getCurrentSellerData, updateTemplate]);

  const handleDeleteTemplate = useCallback(() => {
    if (!selectedTemplateId) return;
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    removeTemplate(selectedTemplateId);
    setSelectedTemplateId(null);
    setIsNaming(false);
    setIsEditing(false);
    const s = EMPTY_SELLER;
    setValue('seller.name', s.name);
    setValue('seller.companyName', s.companyName);
    setValue('seller.vatNumber', s.vatNumber);
    setValue('seller.country', s.country);
    setValue('seller.city', s.city);
    setValue('seller.zipCode', s.zipCode);
    setValue('seller.street', s.street);
    setValue('seller.streetNumber', s.streetNumber);
    setValue('seller.email', s.email);
    setValue('seller.phone', s.phone);
    toast.success(`Template "${tpl?.label}" deleted`);
  }, [selectedTemplateId, templates, removeTemplate, setValue]);

  const onSubmit = async (data: FormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await postInvoiceMonthlyAdmin({
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
            email: data.seller.email || null,
            phone: data.seller.phone || null,
            name: data.seller.name || null,
            companyName: data.seller.companyName || null,
            vatNumber: data.seller.vatNumber || null,
          },
          buyer: {
            country: data.buyer.country,
            city: data.buyer.city,
            zipCode: data.buyer.zipCode,
            street: data.buyer.street,
            streetNumber: data.buyer.streetNumber,
            email: data.buyer.email || null,
            phone: data.buyer.phone || null,
            name: data.buyer.name || null,
            companyName: data.buyer.companyName || null,
            vatNumber: data.buyer.vatNumber || null,
          },
          invoice: data.invoice
            ? Object.fromEntries(
                Object.entries(data.invoice).filter(([, v]) => v !== '' && v !== undefined),
              )
            : undefined,
        },
      });

      if (result.error) {
        const rawMessage = extractApiErrorMessage(result.error, 'Failed to generate invoice');
        setSubmitError(mapInvoiceApiErrorMessage(rawMessage));
        setIsSubmitting(false);
        return;
      }

      if (result.data?.data) {
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
    } catch (err) {
      const rawMessage = extractApiErrorMessage(err, 'Failed to generate invoice');
      setSubmitError(mapInvoiceApiErrorMessage(rawMessage));
    } finally {
      setIsSubmitting(false);
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
              <Label>Buyer Wallet VKey</Label>
              <div className="flex items-center gap-2 h-10 rounded-md border border-input bg-muted/50 px-3 py-2">
                <span className="font-mono text-sm text-muted-foreground">
                  {shortenAddress(prefillBuyerWalletVkey, 12)}
                </span>
                <CopyButton value={prefillBuyerWalletVkey} />
              </div>
              <input type="hidden" {...register('buyerWalletVkey')} />
            </div>
            <div>
              <Label>Month</Label>
              <div className="flex items-center h-10 rounded-md border border-input bg-muted/50 px-3 py-2">
                <span className="text-sm text-muted-foreground">{formatMonth(prefillMonth)}</span>
              </div>
              <input type="hidden" {...register('month')} />
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
              {errors.vatRate && (
                <p className="text-xs text-destructive mt-1">{errors.vatRate.message}</p>
              )}
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
            {(vatRate ?? 0) > 0 && !reverseCharge && (
              <div className="col-span-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-300">
                EU VAT notice: ensure VAT is stated in the seller&apos;s local currency (Article 230
                VAT Directive). This is a warning only and does not block generation.
              </div>
            )}
          </div>

          <Separator />

          {/* Seller Details */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium">Seller Details</h4>
              <div className="flex items-center gap-2">
                {templates.length > 0 && (
                  <Select
                    value={selectedTemplateId ?? '__none__'}
                    onValueChange={(val) => {
                      if (val === '__none__') {
                        clearTemplate();
                      } else {
                        applyTemplate(val);
                      }
                    }}
                  >
                    <SelectTrigger className="w-[180px] h-8 text-xs">
                      <SelectValue placeholder="Load template..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No template</SelectItem>
                      {templates.map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.id}>
                          {tpl.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {selectedTemplateId && !isNaming && !isEditing && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      title="Update template with current values"
                      onClick={() => {
                        const tpl = templates.find((t) => t.id === selectedTemplateId);
                        setTemplateNameInput(tpl?.label ?? '');
                        setIsEditing(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-destructive hover:text-destructive"
                      title="Delete template"
                      onClick={handleDeleteTemplate}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                {!isNaming && !isEditing && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      setIsNaming(true);
                      setTemplateNameInput('');
                    }}
                  >
                    <Save className="h-3.5 w-3.5 mr-1" />
                    Save as Template
                  </Button>
                )}
              </div>
            </div>

            {/* Save / Edit template name input */}
            {(isNaming || isEditing) && (
              <div className="flex items-center gap-2 mb-3">
                <Input
                  value={templateNameInput}
                  onChange={(e) => setTemplateNameInput(e.target.value)}
                  placeholder="Template name"
                  className="h-8 text-sm flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (isEditing) handleUpdateTemplate();
                      else handleSaveTemplate();
                    }
                    if (e.key === 'Escape') {
                      setIsNaming(false);
                      setIsEditing(false);
                    }
                  }}
                  autoFocus
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!templateNameInput.trim()}
                  onClick={isEditing ? handleUpdateTemplate : handleSaveTemplate}
                >
                  {isEditing ? 'Update' : 'Save'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    setIsNaming(false);
                    setIsEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}

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
                  {errors.invoice?.date && (
                    <p className="text-xs text-destructive mt-1">{errors.invoice.date.message}</p>
                  )}
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

          {submitError && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
              {submitError}
            </div>
          )}

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
