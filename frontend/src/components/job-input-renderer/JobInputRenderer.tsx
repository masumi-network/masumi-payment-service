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
import {
  JobInputSchemaType,
  ValidJobInputTypes,
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

  const handleChange = (
    newValue: string | number | boolean | number[] | null,
  ) => {
    if (onChange) {
      onChange(newValue);
    }
  };

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
            onChange={(e) =>
              handleChange(
                e.target.value === '' ? null : Number(e.target.value),
              )
            }
            disabled={disabled}
          />
        );

      case ValidJobInputTypes.BOOLEAN:
        return (
          <Switch
            id={id}
            checked={typeof currentValue === 'boolean' ? currentValue : false}
            onCheckedChange={handleChange}
            disabled={disabled}
          />
        );

      case ValidJobInputTypes.OPTION:
        if (!data?.values) return null;

        const isSingle = isSingleOption(jobInputSchema);

        if (isSingle) {
          // Single select
          const selectedValue =
            Array.isArray(currentValue) && currentValue.length > 0
              ? data.values[currentValue[0]]
              : '';

          return (
            <Select
              value={selectedValue}
              onValueChange={(value) =>
                handleChange([data.values.indexOf(value)])
              }
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an option" />
              </SelectTrigger>
              <SelectContent>
                {data.values.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        } else {
          // Multiple select (checkboxes)
          const selectedValues = Array.isArray(currentValue)
            ? currentValue.map((index: number) => data.values[index])
            : [];

          return (
            <div className="space-y-2">
              {data.values.map((value, index) => (
                <div key={value} className="flex items-center space-x-2">
                  <Checkbox
                    id={`${id}-${index}`}
                    checked={selectedValues.includes(value)}
                    onCheckedChange={(checked) => {
                      const newSelectedValues = checked
                        ? [...selectedValues, value]
                        : selectedValues.filter((v: string) => v !== value);

                      const newIndices = newSelectedValues
                        .map((v: string) => data.values.indexOf(v))
                        .sort();

                      handleChange(newIndices);
                    }}
                    disabled={disabled}
                  />
                  <Label htmlFor={`${id}-${index}`} className="text-sm">
                    {value}
                  </Label>
                </div>
              ))}
            </div>
          );
        }

      case ValidJobInputTypes.FILE:
        return (
          <Input
            id={id}
            type="file"
            accept={data?.accept}
            multiple={data?.multiple}
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleChange(file.name); // Store filename for demo purposes
              }
            }}
          />
        );

      case ValidJobInputTypes.NONE:
        return (
          <div className="text-sm text-muted-foreground italic">
            {data?.description || 'No input required'}
          </div>
        );

      default:
        return (
          <div className="text-sm text-muted-foreground italic">
            Unknown input type: {type}
          </div>
        );
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {name} {!isFieldOptional && '*'}
      </Label>
      {renderField()}
      {data?.description && (
        <p className="text-xs text-muted-foreground">{data.description}</p>
      )}
    </div>
  );
}
