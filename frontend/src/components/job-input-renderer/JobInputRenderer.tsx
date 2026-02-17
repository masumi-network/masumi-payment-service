import React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  JobInputSchemaType,
  ValidJobInputTypes,
  ValidJobInputValidationTypes,
  isOptional,
  isSingleOption,
  getDefaultValue,
} from '@/lib/job-input-schema';

interface JobInputRendererProps {
  jobInputSchema: JobInputSchemaType;
  value?: string | number | boolean | number[] | null;
  onChange?: (value: string | number | boolean | number[] | null) => void;
  disabled?: boolean;
}

export default function JobInputRenderer({
  jobInputSchema,
  value,
  onChange,
  disabled = false,
}: JobInputRendererProps) {
  const { id, name, type, data } = jobInputSchema;
  const isFieldOptional = isOptional(jobInputSchema);
  const defaultValue = getDefaultValue(jobInputSchema);
  const currentValue = value !== undefined ? value : defaultValue;

  const handleChange = (newValue: string | number | boolean | number[] | null) => {
    if (onChange) {
      onChange(newValue);
    }
  };

  if (type === ValidJobInputTypes.HIDDEN) {
    return <input type="hidden" id={id} value={jobInputSchema.data.value} />;
  }

  const renderField = () => {
    switch (type) {
      case ValidJobInputTypes.STRING:
        return (
          <Input
            id={id}
            placeholder={data?.placeholder}
            type="text"
            value={typeof currentValue === 'string' ? currentValue : ''}
            onChange={(e) => handleChange(e.target.value)}
            disabled={disabled}
          />
        );

      case ValidJobInputTypes.TEXTAREA:
        return (
          <Textarea
            id={id}
            placeholder={data?.placeholder}
            value={typeof currentValue === 'string' ? currentValue : ''}
            onChange={(e) => handleChange(e.target.value)}
            disabled={disabled}
          />
        );

      case ValidJobInputTypes.NUMBER:
        return (
          <Input
            id={id}
            placeholder={data?.placeholder}
            type="number"
            value={currentValue !== null ? currentValue.toString() : ''}
            onChange={(e) => handleChange(e.target.value === '' ? null : Number(e.target.value))}
            disabled={disabled}
          />
        );

      case ValidJobInputTypes.BOOLEAN:
        return (
          <div className="flex items-center space-x-2">
            <Switch
              id={id}
              checked={typeof currentValue === 'boolean' ? currentValue : false}
              onCheckedChange={handleChange}
              disabled={disabled}
            />
            <Label htmlFor={id} className="text-sm text-muted-foreground">
              {data?.description || data?.placeholder || 'Yes'}
            </Label>
          </div>
        );

      case ValidJobInputTypes.OPTION: {
        if (!data?.values) return null;

        const isSingle = isSingleOption(jobInputSchema);

        if (isSingle) {
          const selectedValue =
            Array.isArray(currentValue) && currentValue.length > 0
              ? data.values[currentValue[0]]
              : '';

          return (
            <Select
              value={selectedValue}
              onValueChange={(val) => handleChange([data.values.indexOf(val)])}
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an option" />
              </SelectTrigger>
              <SelectContent>
                {data.values.map((val) => (
                  <SelectItem key={val} value={val}>
                    {val}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        } else {
          const selectedValues = Array.isArray(currentValue)
            ? currentValue.map((index: number) => data.values[index])
            : [];

          return (
            <div className="space-y-2">
              {data.values.map((val, index) => (
                <div key={val} className="flex items-center space-x-2">
                  <Checkbox
                    id={`${id}-${index}`}
                    checked={selectedValues.includes(val)}
                    onCheckedChange={(checked) => {
                      const newSelectedValues = checked
                        ? [...selectedValues, val]
                        : selectedValues.filter((v: string) => v !== val);

                      const newIndices = newSelectedValues
                        .map((v: string) => data.values.indexOf(v))
                        .sort();

                      handleChange(newIndices);
                    }}
                    disabled={disabled}
                  />
                  <Label htmlFor={`${id}-${index}`} className="text-sm">
                    {val}
                  </Label>
                </div>
              ))}
            </div>
          );
        }
      }

      case ValidJobInputTypes.FILE: {
        const fileAccept = jobInputSchema.validations?.find(
          (v) => v.validation === ValidJobInputValidationTypes.ACCEPT,
        )?.value;
        return (
          <Input
            id={id}
            type="file"
            accept={fileAccept}
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleChange(file.name);
              }
            }}
          />
        );
      }

      case ValidJobInputTypes.EMAIL:
      case ValidJobInputTypes.PASSWORD:
      case ValidJobInputTypes.TEL:
      case ValidJobInputTypes.URL:
      case ValidJobInputTypes.SEARCH:
        return (
          <Input
            id={id}
            placeholder={data?.placeholder}
            type={type}
            value={typeof currentValue === 'string' ? currentValue : ''}
            onChange={(e) => handleChange(e.target.value)}
            disabled={disabled}
          />
        );

      // Date/time inputs — stored and passed as strings
      case ValidJobInputTypes.DATE:
      case ValidJobInputTypes.DATETIME_LOCAL:
      case ValidJobInputTypes.TIME:
      case ValidJobInputTypes.MONTH:
      case ValidJobInputTypes.WEEK:
        return (
          <Input
            id={id}
            type={type}
            value={typeof currentValue === 'string' ? currentValue : ''}
            onChange={(e) => handleChange(e.target.value)}
            disabled={disabled}
          />
        );

      case ValidJobInputTypes.COLOR: {
        // Prefer currentValue, then data.default, then fallback to black
        const colorFallback = typeof data?.default === 'string' ? data.default : '#000000';
        const colorValue = typeof currentValue === 'string' ? currentValue : colorFallback;
        return (
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="color"
              value={colorValue}
              onChange={(e) => handleChange(e.target.value)}
              disabled={disabled}
              className="w-12 h-10 p-1 cursor-pointer"
            />
            <span className="text-sm font-mono text-muted-foreground">{colorValue}</span>
          </div>
        );
      }

      case ValidJobInputTypes.RANGE: {
        const rangeMin = Number(data?.min ?? 0);
        const rangeMax = Number(data?.max ?? 100);
        const rangeStep = Number(data?.step ?? 1);
        // Use data.default as the initial position if currentValue is null
        const rangeDefault = Number(data?.default ?? data?.min ?? 0);
        const rangeValue = typeof currentValue === 'number' ? currentValue : rangeDefault;
        return (
          <div className="space-y-3">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{rangeMin}</span>
              <span className="font-medium text-foreground">{rangeValue}</span>
              <span>{rangeMax}</span>
            </div>
            <Slider
              id={id}
              min={rangeMin}
              max={rangeMax}
              step={rangeStep}
              value={[rangeValue]}
              onValueChange={(values) => handleChange(values[0])}
              disabled={disabled}
              className="w-full"
            />
          </div>
        );
      }

      case ValidJobInputTypes.CHECKBOX:
        return (
          <div className="flex items-center space-x-2">
            <Checkbox
              id={id}
              checked={typeof currentValue === 'boolean' ? currentValue : false}
              onCheckedChange={(checked) => handleChange(!!checked)}
              disabled={disabled}
            />
            {data?.description && (
              <Label htmlFor={id} className="text-sm">
                {data.description}
              </Label>
            )}
          </div>
        );

      // Radio — single selection from values list, stored as numeric index
      case ValidJobInputTypes.RADIO: {
        if (!data?.values) return null;
        const selectedValue =
          typeof currentValue === 'number' ? data.values[currentValue] : undefined;
        return (
          <RadioGroup
            value={selectedValue}
            onValueChange={(val) => {
              const index = data.values.indexOf(val);
              handleChange(index);
            }}
            disabled={disabled}
          >
            {data.values.map((val, index) => (
              <div key={val} className="flex items-center space-x-2">
                <RadioGroupItem value={val} id={`${id}-${index}`} />
                <Label htmlFor={`${id}-${index}`} className="text-sm font-normal cursor-pointer">
                  {val}
                </Label>
              </div>
            ))}
          </RadioGroup>
        );
      }

      case ValidJobInputTypes.NONE:
        return (
          <div className="text-sm text-muted-foreground italic">
            {data?.description || 'No input required'}
          </div>
        );

      default:
        return (
          <div className="text-sm text-muted-foreground italic">Unknown input type: {type}</div>
        );
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {name} {!isFieldOptional && '*'}
      </Label>
      {renderField()}
      {data?.description &&
        type !== ValidJobInputTypes.BOOLEAN &&
        type !== ValidJobInputTypes.CHECKBOX &&
        type !== ValidJobInputTypes.NONE && (
          <p className="text-xs text-muted-foreground">{data.description}</p>
        )}
    </div>
  );
}
