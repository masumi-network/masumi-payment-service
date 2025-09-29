/* eslint-disable @typescript-eslint/no-explicit-any */

import { MainLayout } from '@/components/layout/MainLayout';
import Head from 'next/head';
import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from '@/lib/contexts/ThemeContext';
import { jobInputSchema, JobInputSchemaType } from '@/lib/job-input-schema';
import JobInputsFormRenderer from '@/components/job-input-renderer/JobInputsFormRenderer';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
});

const DEFAULT_SCHEMA = `{
  "id": "example-input",
  "type": "string",
  "name": "Example name",
  "data": {
    "placeholder": "test 123 (optional)",
    "description": "This is an example input (optional)"
  },
  "validations": [
    { "validation": "min", "value": "5" },
    { "validation": "max", "value": "55" },
    { "validation": "format", "value": "email" }
  ]
}`;

const EXAMPLES = [
  {
    label: 'String Input',
    value: `{
  "id": "email-input",
  "type": "string",
  "name": "Email",
  "data": {
    "placeholder": "Enter your email",
    "description": "User email address"
  },
  "validations": [
    { "validation": "format", "value": "email" },
    { "validation": "min", "value": "5" },
    { "validation": "max", "value": "55" }
  ]
}`,
  },
  {
    label: 'Number Input',
    value: `{
  "id": "age-input",
  "type": "number",
  "name": "Age",
  "data": {
    "description": "User's age in years (optional)"
  },
  "validations": [
    { "validation": "min", "value": "18" },
    { "validation": "max", "value": "120" },
    { "validation": "format", "value": "integer" }
  ]
}`,
  },
  {
    label: 'Option Input',
    value: `{
  "id": "company-type",
  "type": "option",
  "name": "Company type",
  "data": {
    "description": "Please select the legal entity to analyze",
    "values": ["AG", "GmbH", "UG"]
  },
  "validations": [
    { "validation": "min", "value": "1" },
    { "validation": "max", "value": "1" }
  ]
}`,
  },
  {
    label: 'Boolean Input',
    value: `{
  "id": "terms-accepted",
  "type": "boolean",
  "name": "Accept Terms",
  "data": {
    "description": "I agree to the terms and conditions"
  }
}`,
  },
  {
    label: 'File Input',
    value: `{
  "id": "document-upload",
  "type": "file",
  "name": "Document Upload",
  "data": {
    "accept": ".pdf,.doc,.docx",
    "maxSize": "10485760",
    "description": "PDF or Word documents only (max 10MB)",
    "outputFormat": "base64"
  }
}`,
  },
  {
    label: 'Multiple Fields',
    value: `[
  {
    "id": "name",
    "type": "string",
    "name": "Full Name",
    "data": {
      "placeholder": "Enter your full name",
      "description": "Your complete name as it appears on official documents"
    },
    "validations": [
      { "validation": "min", "value": "2" },
      { "validation": "max", "value": "100" }
    ]
  },
  {
    "id": "email",
    "type": "string",
    "name": "Email Address",
    "data": {
      "placeholder": "your.email@example.com",
      "description": "Your primary email address"
    },
    "validations": [
      { "validation": "format", "value": "email" }
    ]
  },
  {
    "id": "age",
    "type": "number",
    "name": "Age",
    "data": {
      "description": "Your current age (optional)"
    },
    "validations": [
      { "validation": "min", "value": "18" },
      { "validation": "max", "value": "120" },
      { "validation": "format", "value": "integer" }
    ]
  },
  {
    "id": "interests",
    "type": "option",
    "name": "Interests",
    "data": {
      "description": "Select your areas of interest",
      "values": ["Technology", "Sports", "Music", "Art", "Science", "Travel"]
    },
    "validations": [
      { "validation": "min", "value": "1" },
      { "validation": "max", "value": "3" }
    ]
  },
  {
    "id": "newsletter",
    "type": "boolean",
    "name": "Newsletter Subscription",
    "data": {
      "description": "Subscribe to our newsletter for updates (optional)"
    }
  }
]`,
  },
  {
    label: 'With Optional Wrapper',
    value: `{
  "input_data": [
    {
      "id": "project-name",
      "type": "string",
      "name": "Project Name",
      "data": {
        "placeholder": "Enter project name",
        "description": "The name of your project"
      },
      "validations": [
        { "validation": "min", "value": "3" },
        { "validation": "max", "value": "50" }
      ]
    },
    {
      "id": "description",
      "type": "string", 
      "name": "Description",
      "data": {
        "placeholder": "Describe your project",
        "description": "Brief description of the project (optional)"
      },
      "validations": [
        { "validation": "max", "value": "500" }
      ]
    },
    {
      "id": "document",
      "type": "file",
      "name": "Project Document",
      "data": {
        "description": "Upload project documentation (PDF/Word, max 4.5MB)",
        "outputFormat": "string"
      }
    },
    {
      "id": "priority",
      "type": "option",
      "name": "Priority Level",
      "data": {
        "description": "Select the priority level",
        "values": ["Low", "Medium", "High", "Critical"]
      },
      "validations": [
        { "validation": "min", "value": "1" },
        { "validation": "max", "value": "1" }
      ]
    }
  ]
}`,
  },
];

function validateSchemaWithZod(input: string): {
  valid: boolean;
  errors: { message: string; line?: number }[];
  parsedSchemas?: JobInputSchemaType[];
} {
  let parsed: any;
  try {
    parsed = JSON.parse(input);
  } catch (e: any) {
    // Try to extract line number from error message
    const match = e.message.match(/at position (\d+)/);
    let line;
    if (match) {
      const pos = parseInt(match[1], 10);
      line = input.slice(0, pos).split('\n').length;
    }
    return {
      valid: false,
      errors: [{ message: 'Invalid JSON: ' + e.message, line }],
    };
  }

  const errors: { message: string; line?: number }[] = [];
  const schemas: JobInputSchemaType[] = [];

  // Helper to get line number for a key
  const getLine = (key: string) => {
    const idx = input.indexOf('"' + key + '"');
    if (idx === -1) return undefined;
    return input.slice(0, idx).split('\n').length;
  };

  // Handle wrapped format, single schema, and array of schemas
  let schemasToValidate: any[];
  if (parsed.input_data && Array.isArray(parsed.input_data)) {
    // Handle wrapped format: { "input_data": [...] }
    schemasToValidate = parsed.input_data;
  } else if (Array.isArray(parsed)) {
    // Handle array format: [...]
    schemasToValidate = parsed;
  } else {
    // Handle single schema format: { ... }
    schemasToValidate = [parsed];
  }

  schemasToValidate.forEach((schema: any, index: number) => {
    try {
      const validatedSchema = jobInputSchema.parse(schema);
      schemas.push(validatedSchema);
    } catch (zodError: any) {
      if (zodError.errors) {
        zodError.errors.forEach((error: any) => {
          errors.push({
            message: `Schema ${index + 1}: ${error.message}`,
            line: getLine(error.path?.[0] || ''),
          });
        });
      } else {
        errors.push({
          message: `Schema ${index + 1}: ${zodError.message}`,
          line: getLine('type'),
        });
      }
    }
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    parsedSchemas: schemas,
  };
}

export default function InputSchemaValidatorPage() {
  const [jsonInput, setJsonInput] = useState<string>(DEFAULT_SCHEMA);
  const { theme } = useTheme();
  const [selectedExample, setSelectedExample] = useState<string>('');

  const handleJsonInputChange = (value: string) => {
    setJsonInput(value);
    setSelectedExample('');
  };

  // Memoize validation for performance
  const validation = useMemo(
    () => validateSchemaWithZod(jsonInput),
    [jsonInput],
  );

  const handleSelectExample = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedExample(val);
    const found = EXAMPLES.find((ex) => ex.label === val);
    if (found) setJsonInput(found.value);
  };

  return (
    <MainLayout>
      <Head>
        <title>Input Schema Validator | Admin Interface</title>
      </Head>
      <div className="space-y-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold mb-1">Input Schema Validator</h1>
          <p className="text-sm text-muted-foreground">
            Validate your Masumi input schemas against the{' '}
            <a
              href="https://github.com/masumi-network/masumi-improvement-proposals/blob/main/MIPs/MIP-003/MIP-003-Attachement-01.md"
              target="_blank"
              className="font-medium text-foreground hover:underline"
            >
              MIP-003
            </a>{' '}
            specification and see how they will render in Sokosumi.
          </p>
        </div>
        <div className="flex flex-col md:flex-row gap-6 min-h-[700px]">
          <div className="flex-1 border rounded-lg p-4 bg-background overflow-hidden flex flex-col gap-2 h-full">
            <div className="flex justify-between items-center mb-2 h-[30px]">
              <div className="text-sm text-muted-foreground">Input Schema</div>
              <div className="flex gap-2 items-center">
                <select
                  className="border rounded px-2 py-1 text-sm bg-background"
                  value={selectedExample}
                  onChange={handleSelectExample}
                >
                  <option value="">Load Example...</option>
                  {EXAMPLES.map((ex) => (
                    <option key={ex.label} value={ex.label}>
                      {ex.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="bg-muted rounded border text-xs overflow-x-auto flex-1 h-full">
              <MonacoEditor
                height="600px"
                defaultLanguage="json"
                value={jsonInput}
                onChange={(value) => handleJsonInputChange(value ?? '')}
                theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  formatOnPaste: true,
                  formatOnType: true,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>
          <div className="flex-1 border rounded-lg p-4 bg-background overflow-auto flex flex-col gap-2 h-full">
            {validation.valid ? (
              <div className="flex-1 flex flex-col gap-2 h-full">
                <div className="text-green-600 font-semibold mb-2 h-[30px] flex items-center">
                  Schema is valid! ✓
                </div>
                <div className="flex-1 overflow-auto">
                  <JobInputsFormRenderer
                    jobInputSchemas={validation.parsedSchemas || []}
                  />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col gap-2 h-full">
                <div className="text-destructive font-semibold mb-2 h-[30px] flex items-center">
                  Schema is invalid:
                </div>
                <div className="flex-1 overflow-auto">
                  <div className="bg-muted rounded border p-4">
                    <ul className="list-disc pl-5 space-y-1">
                      {validation.errors.map((err, i) => (
                        <li key={i} className="text-sm">
                          {err.line ? (
                            <span className="text-xs text-muted-foreground">
                              (line {err.line}){' '}
                            </span>
                          ) : null}
                          {err.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
