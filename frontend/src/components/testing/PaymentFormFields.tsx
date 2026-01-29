import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useState, useEffect, useCallback } from 'react';
import {
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
  Control,
  Controller,
  FieldErrors,
} from 'react-hook-form';
import { generateRandomHex, generateMIP004InputHash } from './utils';
import { RefreshCw, ExternalLink } from 'lucide-react';

export const INPUT_DATA_PRESETS = [
  {
    label: 'Text Prompt',
    value: JSON.stringify(
      { prompt: 'Summarize the latest advances in quantum computing' },
      null,
      2,
    ),
  },
  {
    label: 'Email Analysis',
    value: JSON.stringify(
      {
        email: 'user@example.com',
        name: 'Jane Doe',
        action: 'analyze',
      },
      null,
      2,
    ),
  },
  {
    label: 'Document Processing',
    value: JSON.stringify(
      {
        'document-url': 'https://example.com/report.pdf',
        language: 'en',
        'output-format': 'summary',
      },
      null,
      2,
    ),
  },
  {
    label: 'Multi-field Form',
    value: JSON.stringify(
      {
        'project-name': 'My Project',
        description: 'A sample project for testing',
        age: 30,
        newsletter: true,
        interests: ['Technology', 'Science'],
      },
      null,
      2,
    ),
  },
];

import { z } from 'zod';

export const paymentFormSchema = z.object({
  agentIdentifier: z.string().min(57, 'Agent identifier required'),
  inputHash: z
    .string()
    .length(64, 'Input hash must be 64 characters')
    .regex(/^[0-9a-fA-F]+$/, 'Must be valid hex'),
  identifierFromPurchaser: z
    .string()
    .min(14, 'Minimum 14 characters')
    .max(26, 'Maximum 26 characters')
    .regex(/^[0-9a-fA-F]+$/, 'Must be valid hex'),
  metadata: z.string().optional(),
});

export type PaymentFormValues = z.infer<typeof paymentFormSchema>;

interface PaidAgent {
  id: string;
  name: string;
  agentIdentifier: string | null;
}

interface PaymentFormFieldsProps {
  register: UseFormRegister<PaymentFormValues>;
  setValue: UseFormSetValue<PaymentFormValues>;
  watch: UseFormWatch<PaymentFormValues>;
  control: Control<PaymentFormValues>;
  errors: FieldErrors<PaymentFormValues>;
  paidAgents: PaidAgent[];
  isLoadingAgents: boolean;
}

export function useInputDataHash(
  setValue: UseFormSetValue<PaymentFormValues>,
  watch: UseFormWatch<PaymentFormValues>,
) {
  const [inputData, setInputData] = useState('');
  const [inputDataError, setInputDataError] = useState<string | null>(null);

  const identifierFromPurchaser = watch('identifierFromPurchaser');

  const recalculateHash = useCallback(
    async (data: string, identifier: string) => {
      if (!data.trim()) {
        setValue('inputHash', '');
        setInputDataError(null);
        return;
      }
      try {
        const parsed = JSON.parse(data);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setInputDataError('Input data must be a JSON object');
          setValue('inputHash', '');
          return;
        }
        setInputDataError(null);
        const hash = await generateMIP004InputHash(parsed, identifier);
        setValue('inputHash', hash);
      } catch {
        setInputDataError('Invalid JSON');
        setValue('inputHash', '');
      }
    },
    [setValue],
  );

  useEffect(() => {
    recalculateHash(inputData, identifierFromPurchaser);
  }, [inputData, identifierFromPurchaser, recalculateHash]);

  const resetInputData = useCallback((defaultPreset = true) => {
    setInputData(defaultPreset ? INPUT_DATA_PRESETS[0].value : '');
    setInputDataError(null);
  }, []);

  return { inputData, setInputData, inputDataError, resetInputData };
}

export function PaymentFormFields({
  register,
  setValue,
  watch: _watch,
  control,
  errors,
  paidAgents,
  isLoadingAgents,
  inputData,
  setInputData,
  inputDataError,
}: PaymentFormFieldsProps & {
  inputData: string;
  setInputData: (value: string) => void;
  inputDataError: string | null;
}) {
  const [isSpinning, setIsSpinning] = useState(false);

  const handleGenerateIdentifier = () => {
    setIsSpinning(true);
    setValue('identifierFromPurchaser', generateRandomHex(16));
    setTimeout(() => setIsSpinning(false), 500);
  };

  return (
    <>
      {/* Agent Selection */}
      <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-1">
        <Label>
          Agent <span className="text-red-500">*</span>
        </Label>
        <Controller
          control={control}
          name="agentIdentifier"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger
                disabled={isLoadingAgents || paidAgents.length === 0}
                className={`transition-colors duration-200 ${errors.agentIdentifier ? 'border-red-500' : ''}`}
              >
                <SelectValue
                  placeholder={
                    isLoadingAgents
                      ? 'Loading agents...'
                      : paidAgents.length === 0
                        ? 'No paid agents available'
                        : 'Select a paid agent'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {paidAgents.map((agent) => (
                  <SelectItem
                    key={agent.id}
                    value={agent.agentIdentifier || ''}
                  >
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.agentIdentifier && (
          <p className="text-sm text-red-500 animate-fade-in">
            {errors.agentIdentifier.message}
          </p>
        )}
        {paidAgents.length === 0 && !isLoadingAgents && (
          <p className="text-xs text-muted-foreground">
            No paid agents available. Free agents cannot be used with the
            payment flow.
          </p>
        )}
      </div>

      {/* Purchaser Identifier */}
      <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-2">
        <div className="flex items-center justify-between">
          <Label>
            Purchaser Identifier <span className="text-red-500">*</span>
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleGenerateIdentifier}
            className="h-6 text-xs hover:bg-muted/80 transition-colors duration-150"
          >
            <RefreshCw
              className={`h-3 w-3 mr-1 transition-transform duration-500 ${isSpinning ? 'animate-spin' : ''}`}
            />
            Regenerate
          </Button>
        </div>
        <Input
          {...register('identifierFromPurchaser')}
          placeholder="14-26 character hex string"
          className={`font-mono text-xs transition-colors duration-200 ${errors.identifierFromPurchaser ? 'border-red-500' : ''}`}
        />
        {errors.identifierFromPurchaser && (
          <p className="text-sm text-red-500 animate-fade-in">
            {errors.identifierFromPurchaser.message}
          </p>
        )}
      </div>

      {/* Input Data & Hash (MIP-004) */}
      <Card className="animate-fade-in-up opacity-0 animate-stagger-3 transition-shadow duration-200 hover:shadow-md">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Input hashed per{' '}
              <a
                href="https://docs.masumi.network/mips/_mip-004"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5 hover:text-foreground transition-colors duration-150"
              >
                MIP-004
                <ExternalLink className="h-3 w-3" />
              </a>
              {' '}&mdash; SHA-256(identifier + &quot;;&quot; +
              JCS(input_data))
            </p>
            <Select onValueChange={(value) => setInputData(value)}>
              <SelectTrigger className="w-[160px] h-7 text-xs shrink-0">
                <SelectValue placeholder="Load preset..." />
              </SelectTrigger>
              <SelectContent>
                {INPUT_DATA_PRESETS.map((preset) => (
                  <SelectItem key={preset.label} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>
              Input Data <span className="text-red-500">*</span>
            </Label>
            <Textarea
              value={inputData}
              onChange={(e) => setInputData(e.target.value)}
              placeholder='{"key": "value"}'
              rows={8}
              className={`font-mono text-xs transition-colors duration-200 ${inputDataError ? 'border-red-500' : ''}`}
            />
            {inputDataError && (
              <p className="text-sm text-red-500 animate-fade-in">
                {inputDataError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground font-normal">
              Input Hash
            </Label>
            <Input
              {...register('inputHash')}
              readOnly
              placeholder="Auto-generated from input data"
              className={`font-mono text-xs bg-muted cursor-default transition-colors duration-200 ${errors.inputHash ? 'border-red-500' : ''}`}
            />
            {errors.inputHash && (
              <p className="text-sm text-red-500 animate-fade-in">
                {errors.inputHash.message}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metadata */}
      <div className="space-y-2 animate-fade-in-up opacity-0 animate-stagger-4">
        <Label>Metadata (Optional)</Label>
        <Textarea
          {...register('metadata')}
          placeholder="Optional metadata for the payment"
          rows={2}
          className="resize-none"
        />
      </div>
    </>
  );
}
