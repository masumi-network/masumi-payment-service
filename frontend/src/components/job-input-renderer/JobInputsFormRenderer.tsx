import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import JobInputRenderer from './JobInputRenderer';
import { JobInputSchemaType, getDefaultValue } from '@/lib/job-input-schema';

interface JobInputsFormRendererProps {
  jobInputSchemas: JobInputSchemaType[];
  onFormDataChange?: (
    formData: Record<string, string | number | boolean | number[] | null>,
  ) => void;
  disabled?: boolean;
}

export default function JobInputsFormRenderer({
  jobInputSchemas,
  onFormDataChange,
  disabled = false,
}: JobInputsFormRendererProps) {
  const [formData, setFormData] = useState<
    Record<string, string | number | boolean | number[] | null>
  >({});

  // Initialize form data with default values
  useEffect(() => {
    const initialData: Record<
      string,
      string | number | boolean | number[] | null
    > = {};
    jobInputSchemas.forEach((schema) => {
      initialData[schema.id] = getDefaultValue(schema);
    });
    setFormData(initialData);
  }, [jobInputSchemas]);

  // Notify parent of form data changes
  useEffect(() => {
    if (onFormDataChange) {
      onFormDataChange(formData);
    }
  }, [formData, onFormDataChange]);

  const handleFieldChange = (
    fieldId: string,
    value: string | number | boolean | number[] | null,
  ) => {
    setFormData((prev) => ({
      ...prev,
      [fieldId]: value,
    }));
  };

  const handleClear = () => {
    const clearedData: Record<
      string,
      string | number | boolean | number[] | null
    > = {};
    jobInputSchemas.forEach((schema) => {
      clearedData[schema.id] = getDefaultValue(schema);
    });
    setFormData(clearedData);
  };

  if (jobInputSchemas.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground text-center">
            No input fields defined in the schema.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-muted/20">
      <CardHeader>
        <CardTitle className="text-lg">Rendered Form</CardTitle>
        <p className="text-sm text-muted-foreground">
          This is how the form will appear in Sokosumi
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <form className="space-y-4">
          {jobInputSchemas.map((schema, index) => (
            <div key={schema.id}>
              <JobInputRenderer
                jobInputSchema={schema}
                value={formData[schema.id]}
                onChange={(value) => handleFieldChange(schema.id, value)}
                disabled={disabled}
              />
              {index < jobInputSchemas.length - 1 && (
                <Separator className="my-4" />
              )}
            </div>
          ))}
        </form>

        <div className="flex justify-between items-center pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleClear}
            disabled={disabled}
          >
            Clear Form
          </Button>

          <div className="text-sm text-muted-foreground">
            {Object.keys(formData).length} field
            {Object.keys(formData).length !== 1 ? 's' : ''}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
