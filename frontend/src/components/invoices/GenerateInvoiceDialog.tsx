import { useState, useEffect, useCallback, useRef } from 'react';
import { useForm, useFieldArray, type FieldErrors } from 'react-hook-form';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { ChevronDown, Save, Trash2, Pencil, Check, ChevronsUpDown, X, Plus } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { postInvoiceMonthlyAdmin } from '@/lib/api/generated';
import { shortenAddress } from '@/lib/utils';
import {
  useSellerTemplates,
  useBuyerTemplates,
  type SellerTemplateData,
} from '@/lib/hooks/useSellerTemplates';
import { extractApiErrorMessage, mapInvoiceApiErrorMessage } from '@/lib/api-error';
import { downloadBase64Pdf } from '@/lib/pdf-utils';
import type { InvoiceSummary } from '@/lib/hooks/useInvoices';

const currencies = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'aed'] as const;
const languages = ['en-us', 'en-gb', 'de'] as const;

const EMPTY_ADDRESS: SellerTemplateData = {
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

const conversionEntrySchema = z.object({
  unit: z.string(),
  rate: z.string(),
});

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
    currencyConversions: z.array(conversionEntrySchema).optional(),
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
  prefillSellerWalletVkey?: string;
  prefillMonth: string;
  prefillForceRegenerate?: boolean;
  sourceInvoice?: InvoiceSummary;
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

// Searchable template combobox with inline save/edit/delete
function TemplateCombobox({
  templates,
  selectedId,
  onSelect,
  onClear,
  onSave,
  onUpdate,
  onDelete,
  label,
}: {
  templates: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  onSave: (name: string) => void;
  onUpdate: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'browse' | 'save' | 'rename'>('browse');
  const [nameInput, setNameInput] = useState('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const selectedTemplate = templates.find((t) => t.id === selectedId);

  const handleSave = () => {
    const name = nameInput.trim();
    if (!name) return;
    onSave(name);
    setMode('browse');
    setNameInput('');
    setOpen(false);
  };

  const handleRename = () => {
    const name = nameInput.trim();
    if (!name || !renameTargetId) return;
    onUpdate(renameTargetId, name);
    setMode('browse');
    setNameInput('');
    setRenameTargetId(null);
  };

  const startRename = (id: string, currentLabel: string) => {
    setRenameTargetId(id);
    setNameInput(currentLabel);
    setMode('rename');
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  if (mode === 'save' || mode === 'rename') {
    return (
      <div className="flex items-center gap-2">
        <Input
          ref={nameInputRef}
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder={mode === 'save' ? 'Template name...' : 'New name...'}
          className="h-8 text-xs flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (mode === 'rename') handleRename();
              else handleSave();
            }
            if (e.key === 'Escape') {
              setMode('browse');
              setNameInput('');
              setRenameTargetId(null);
            }
          }}
          autoFocus
        />
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs"
          disabled={!nameInput.trim()}
          onClick={mode === 'rename' ? handleRename : handleSave}
        >
          {mode === 'rename' ? 'Rename' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={() => {
            setMode('browse');
            setNameInput('');
            setRenameTargetId(null);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-8 justify-between text-xs flex-1 min-w-0"
          >
            <span className="truncate">
              {selectedTemplate ? selectedTemplate.label : `Load ${label} template...`}
            </span>
            <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0" align="start">
          <Command
            filter={(value, search) => {
              if (value === '__clear__' || value === '__save_new__') return 1;
              if (value.toLowerCase().includes(search.toLowerCase())) return 1;
              return 0;
            }}
          >
            {templates.length > 0 && (
              <CommandInput placeholder={`Search ${label} templates...`} className="h-9 border-0" />
            )}
            <CommandList>
              <CommandGroup>
                {selectedId && (
                  <CommandItem
                    value="__clear__"
                    onSelect={() => {
                      onClear();
                      setOpen(false);
                    }}
                  >
                    <X className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Clear selection</span>
                  </CommandItem>
                )}
                {templates.map((tpl) => (
                  <CommandItem
                    key={tpl.id}
                    value={tpl.label}
                    onSelect={() => {
                      onSelect(tpl.id);
                      setOpen(false);
                    }}
                    className="group"
                  >
                    <Check
                      className={cn(
                        'mr-2 h-3.5 w-3.5',
                        selectedId === tpl.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="flex-1 truncate">{tpl.label}</span>
                    <span className="hidden group-aria-selected:flex items-center gap-0.5 ml-1">
                      <button
                        type="button"
                        className="p-0.5 rounded hover:bg-accent"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          startRename(tpl.id, tpl.label);
                          setOpen(false);
                        }}
                        title="Rename"
                      >
                        <Pencil className="h-3 w-3 text-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        className="p-0.5 rounded hover:bg-destructive/20"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          onDelete(tpl.id);
                          setOpen(false);
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </button>
                    </span>
                  </CommandItem>
                ))}
                <CommandItem
                  value="__save_new__"
                  onSelect={() => {
                    setMode('save');
                    setNameInput('');
                    setOpen(false);
                  }}
                >
                  <Plus className="mr-2 h-3.5 w-3.5" />
                  Save current as template
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedId && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            title="Overwrite template with current values"
            onClick={() => {
              const tpl = templates.find((t) => t.id === selectedId);
              if (tpl) onUpdate(tpl.id, tpl.label);
            }}
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            title="Delete template"
            onClick={() => onDelete(selectedId)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

export function GenerateInvoiceDialog({
  open,
  onClose,
  onSuccess,
  prefillBuyerWalletVkey,
  prefillSellerWalletVkey,
  prefillMonth,
  prefillForceRegenerate = false,
  sourceInvoice,
  formatMonth,
}: GenerateInvoiceDialogProps) {
  const { apiClient } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Seller templates
  const {
    templates: sellerTemplates,
    save: saveSeller,
    update: updateSeller,
    remove: removeSeller,
  } = useSellerTemplates();
  const [selectedSellerTplId, setSelectedSellerTplId] = useState<string | null>(null);

  // Buyer templates
  const {
    templates: buyerTemplates,
    save: saveBuyer,
    update: updateBuyer,
    remove: removeBuyer,
  } = useBuyerTemplates();
  const [selectedBuyerTplId, setSelectedBuyerTplId] = useState<string | null>(null);

  const buildDefaults = useCallback((): FormValues => {
    const inv = sourceInvoice;
    if (inv) {
      return {
        buyerWalletVkey: prefillBuyerWalletVkey || '',
        month: prefillMonth || '',
        invoiceCurrency: (inv.currencyShortId as (typeof currencies)[number]) || 'usd',
        vatRate: inv.vatRate ?? 0,
        reverseCharge: inv.reverseCharge ?? false,
        forceRegenerate: prefillForceRegenerate,
        currencyConversions: [],
        seller: {
          name: inv.sellerName ?? null,
          companyName: inv.sellerCompanyName ?? null,
          vatNumber: inv.sellerVatNumber ?? null,
          country: inv.sellerCountry,
          city: inv.sellerCity,
          zipCode: inv.sellerZipCode,
          street: inv.sellerStreet,
          streetNumber: inv.sellerStreetNumber,
          email: inv.sellerEmail ?? null,
          phone: inv.sellerPhone ?? null,
        },
        buyer: {
          name: inv.buyerName ?? null,
          companyName: inv.buyerCompanyName ?? null,
          vatNumber: inv.buyerVatNumber ?? null,
          country: inv.buyerCountry,
          city: inv.buyerCity,
          zipCode: inv.buyerZipCode,
          street: inv.buyerStreet,
          streetNumber: inv.buyerStreetNumber,
          email: inv.buyerEmail ?? null,
          phone: inv.buyerPhone ?? null,
        },
        invoice: {
          title: inv.invoiceTitle || undefined,
          description: inv.invoiceDescription || undefined,
          language: (inv.language as (typeof languages)[number]) || undefined,
          localizationFormat: (inv.localizationFormat as (typeof languages)[number]) || undefined,
        },
      };
    }
    return {
      buyerWalletVkey: prefillBuyerWalletVkey || '',
      month: prefillMonth || '',
      invoiceCurrency: 'usd',
      vatRate: 0,
      reverseCharge: false,
      forceRegenerate: prefillForceRegenerate,
      currencyConversions: [],
      seller: { ...EMPTY_ADDRESS },
      buyer: { ...EMPTY_ADDRESS },
      invoice: {},
    };
  }, [sourceInvoice, prefillBuyerWalletVkey, prefillMonth, prefillForceRegenerate]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    getValues,
    control,
    formState: { errors },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: buildDefaults(),
  });

  useEffect(() => {
    if (open) {
      reset(buildDefaults());
      setSelectedSellerTplId(null);
      setSelectedBuyerTplId(null);
      setSubmitError(null);
    }
  }, [open, buildDefaults, reset]);

  const {
    fields: conversionFields,
    append: appendConversion,
    remove: removeConversion,
  } = useFieldArray({ control, name: 'currencyConversions' });

  const reverseCharge = watch('reverseCharge');
  const forceRegenerate = watch('forceRegenerate');
  const invoiceCurrency = watch('invoiceCurrency');
  const vatRate = watch('vatRate');

  // Apply address data to form fields
  const applyAddress = useCallback(
    (prefix: 'seller' | 'buyer', data: SellerTemplateData) => {
      const opts = { shouldDirty: true } as const;
      setValue(`${prefix}.name`, data.name, opts);
      setValue(`${prefix}.companyName`, data.companyName, opts);
      setValue(`${prefix}.vatNumber`, data.vatNumber, opts);
      setValue(`${prefix}.country`, data.country, opts);
      setValue(`${prefix}.city`, data.city, opts);
      setValue(`${prefix}.zipCode`, data.zipCode, opts);
      setValue(`${prefix}.street`, data.street, opts);
      setValue(`${prefix}.streetNumber`, data.streetNumber, opts);
      setValue(`${prefix}.email`, data.email, opts);
      setValue(`${prefix}.phone`, data.phone, opts);
    },
    [setValue],
  );

  const getAddressData = useCallback(
    (prefix: 'seller' | 'buyer'): SellerTemplateData => {
      const v = getValues(prefix);
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
    },
    [getValues],
  );

  // Seller template handlers
  const handleSelectSellerTpl = useCallback(
    (id: string) => {
      const tpl = sellerTemplates.find((t) => t.id === id);
      if (!tpl) return;
      setSelectedSellerTplId(id);
      applyAddress('seller', tpl.seller);
    },
    [sellerTemplates, applyAddress],
  );

  const handleClearSellerTpl = useCallback(() => {
    setSelectedSellerTplId(null);
    applyAddress('seller', EMPTY_ADDRESS);
  }, [applyAddress]);

  const handleSaveSellerTpl = useCallback(
    (name: string) => {
      const data = getAddressData('seller');
      const tpl = saveSeller(name, data);
      setSelectedSellerTplId(tpl.id);
      toast.success(`Seller template "${name}" saved`);
    },
    [getAddressData, saveSeller],
  );

  const handleUpdateSellerTpl = useCallback(
    (id: string, label: string) => {
      const data = getAddressData('seller');
      updateSeller(id, label, data);
      toast.success(`Seller template "${label}" updated`);
    },
    [getAddressData, updateSeller],
  );

  const handleDeleteSellerTpl = useCallback(
    (id: string) => {
      const tpl = sellerTemplates.find((t) => t.id === id);
      removeSeller(id);
      if (selectedSellerTplId === id) {
        setSelectedSellerTplId(null);
        applyAddress('seller', EMPTY_ADDRESS);
      }
      toast.success(`Template "${tpl?.label}" deleted`);
    },
    [sellerTemplates, removeSeller, selectedSellerTplId, applyAddress],
  );

  // Buyer template handlers
  const handleSelectBuyerTpl = useCallback(
    (id: string) => {
      const tpl = buyerTemplates.find((t) => t.id === id);
      if (!tpl) return;
      setSelectedBuyerTplId(id);
      applyAddress('buyer', tpl.data);
    },
    [buyerTemplates, applyAddress],
  );

  const handleClearBuyerTpl = useCallback(() => {
    setSelectedBuyerTplId(null);
    applyAddress('buyer', EMPTY_ADDRESS);
  }, [applyAddress]);

  const handleSaveBuyerTpl = useCallback(
    (name: string) => {
      const data = getAddressData('buyer');
      const tpl = saveBuyer(name, data);
      setSelectedBuyerTplId(tpl.id);
      toast.success(`Buyer template "${name}" saved`);
    },
    [getAddressData, saveBuyer],
  );

  const handleUpdateBuyerTpl = useCallback(
    (id: string, label: string) => {
      const data = getAddressData('buyer');
      updateBuyer(id, label, data);
      toast.success(`Buyer template "${label}" updated`);
    },
    [getAddressData, updateBuyer],
  );

  const handleDeleteBuyerTpl = useCallback(
    (id: string) => {
      const tpl = buyerTemplates.find((t) => t.id === id);
      removeBuyer(id);
      if (selectedBuyerTplId === id) {
        setSelectedBuyerTplId(null);
        applyAddress('buyer', EMPTY_ADDRESS);
      }
      toast.success(`Template "${tpl?.label}" deleted`);
    },
    [buyerTemplates, removeBuyer, selectedBuyerTplId, applyAddress],
  );

  const onSubmit = async (data: FormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // Build currencyConversion map from entries, filtering empty/invalid rows
      const validConversions = (data.currencyConversions ?? []).filter(
        (e) => e.unit.trim() !== '' && e.rate.trim() !== '',
      );
      const currencyConversion: Record<string, number> | undefined =
        validConversions.length > 0
          ? Object.fromEntries(validConversions.map((e) => [e.unit.trim(), parseFloat(e.rate)]))
          : undefined;

      const result = await postInvoiceMonthlyAdmin({
        client: apiClient,
        body: {
          buyerWalletVkey: data.buyerWalletVkey,
          sellerWalletVkey: prefillSellerWalletVkey || undefined,
          month: data.month,
          invoiceCurrency: data.invoiceCurrency,
          vatRate: data.vatRate,
          reverseCharge: data.reverseCharge,
          forceRegenerate: data.forceRegenerate,
          currencyConversion,
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
            <div>
              <Label>Buyer Wallet VKey</Label>
              <div className="flex items-center gap-2 h-10 rounded-md border border-input bg-muted/50 px-3 py-2">
                <span className="font-mono text-sm text-muted-foreground truncate">
                  {shortenAddress(prefillBuyerWalletVkey, 12)}
                </span>
                <CopyButton value={prefillBuyerWalletVkey} />
              </div>
              <input type="hidden" {...register('buyerWalletVkey')} />
            </div>
            <div>
              <Label>Seller Wallet VKey</Label>
              <div className="flex items-center gap-2 h-10 rounded-md border border-input bg-muted/50 px-3 py-2">
                <span className="font-mono text-sm text-muted-foreground truncate">
                  {prefillSellerWalletVkey
                    ? shortenAddress(prefillSellerWalletVkey, 12)
                    : 'Auto-detect'}
                </span>
                {prefillSellerWalletVkey && <CopyButton value={prefillSellerWalletVkey} />}
              </div>
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
            </div>
            <div className="mb-3">
              <TemplateCombobox
                templates={sellerTemplates}
                selectedId={selectedSellerTplId}
                onSelect={handleSelectSellerTpl}
                onClear={handleClearSellerTpl}
                onSave={handleSaveSellerTpl}
                onUpdate={handleUpdateSellerTpl}
                onDelete={handleDeleteSellerTpl}
                label="seller"
              />
            </div>
            <AddressFields prefix="seller" register={register} errors={errors} />
          </div>

          <Separator />

          {/* Buyer Details */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium">Buyer Details</h4>
            </div>
            <div className="mb-3">
              <TemplateCombobox
                templates={buyerTemplates}
                selectedId={selectedBuyerTplId}
                onSelect={handleSelectBuyerTpl}
                onClear={handleClearBuyerTpl}
                onSave={handleSaveBuyerTpl}
                onUpdate={handleUpdateBuyerTpl}
                onDelete={handleDeleteBuyerTpl}
                label="buyer"
              />
            </div>
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

              {/* Custom Currency Conversions */}
              <div className="pt-3">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs text-muted-foreground">
                    Custom Conversions (overrides CoinGecko)
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => appendConversion({ unit: '', rate: '' })}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
                {conversionFields.length > 0 && (
                  <div className="space-y-2">
                    {conversionFields.map((field, index) => (
                      <div key={field.id} className="flex items-center gap-2">
                        <Input
                          {...register(`currencyConversions.${index}.unit`)}
                          placeholder="Unit (e.g. lovelace or policy hex)"
                          className="h-8 text-xs flex-1"
                        />
                        <Input
                          {...register(`currencyConversions.${index}.rate`)}
                          placeholder="Rate per unit"
                          className="h-8 text-xs w-32"
                          type="number"
                          step="any"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => removeConversion(index)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
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
