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
    "outputFormat": "url",
    "description": "PDF or Word documents only (max 10MB)"
  },
  "validations": [
    { "validation": "accept", "value": ".pdf,.doc,.docx" }
  ]
}`,
  },
  {
    label: 'Email Input',
    value: `{
  "id": "user-email",
  "type": "email",
  "name": "Email Address",
  "data": {
    "placeholder": "you@example.com",
    "description": "Your primary email address"
  },
  "validations": [
    { "validation": "format", "value": "email" }
  ]
}`,
  },
  {
    label: 'Date Input',
    value: `{
  "id": "birth-date",
  "type": "date",
  "name": "Date of Birth",
  "data": {
    "description": "Your date of birth"
  }
}`,
  },
  {
    label: 'Color Input',
    value: `{
  "id": "brand-color",
  "type": "color",
  "name": "Brand Color",
  "data": {
    "description": "Pick your brand's primary color",
    "default": "#3b82f6"
  }
}`,
  },
  {
    label: 'Range Input',
    value: `{
  "id": "confidence-level",
  "type": "range",
  "name": "Confidence Level",
  "data": {
    "min": 0,
    "max": 100,
    "step": 5,
    "description": "How confident are you? (0–100)"
  }
}`,
  },
  {
    label: 'Radio Input',
    value: `{
  "id": "priority",
  "type": "radio",
  "name": "Priority",
  "data": {
    "values": ["Low", "Medium", "High", "Critical"],
    "description": "Select the priority level"
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
    "type": "email",
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
        "outputFormat": "url",
        "description": "Upload project documentation (PDF/Word)"
      },
      "validations": [
        { "validation": "accept", "value": ".pdf,.doc,.docx" }
      ]
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

interface ValidationResult {
  valid: boolean;
  errors: { message: string; line?: number }[];
  parsedSchemas?: JobInputSchemaType[];
}

function validateSchemaWithZod(input: string): ValidationResult {
  let parsed: any;
  try {
    parsed = JSON.parse(input);
  } catch (e: any) {
    const line = extractLineFromJsonError(e.message, input);
    return {
      valid: false,
      errors: [{ message: 'Invalid JSON: ' + e.message, line }],
    };
  }

  const errors: { message: string; line?: number }[] = [];
  const schemas: JobInputSchemaType[] = [];
  const schemasToValidate = extractSchemasToValidate(parsed);

  schemasToValidate.forEach((schema: any, index: number) => {
    const normalizedSchema = normalizeSchemaForValidation(schema);

    const preValidationError = validateValidationsField(normalizedSchema, index, input);
    if (preValidationError) {
      errors.push(preValidationError);
      return;
    }

    try {
      const validatedSchema = jobInputSchema.parse(normalizedSchema);
      schemas.push(validatedSchema);
    } catch (zodError: any) {
      const zodErrors = extractZodErrors(zodError, normalizedSchema, index, input);
      errors.push(...zodErrors);
    }
  });

  return buildValidationResult(errors, schemas, schemasToValidate);
}

function extractLineFromJsonError(errorMessage: string, input: string): number | undefined {
  const match = errorMessage.match(/at position (\d+)/);
  if (!match) return undefined;
  const pos = parseInt(match[1], 10);
  return input.slice(0, pos).split('\n').length;
}

function extractSchemasToValidate(parsed: any): any[] {
  if (parsed.input_data && Array.isArray(parsed.input_data)) {
    return parsed.input_data;
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return [parsed];
}

function normalizeSchemaForValidation(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.validations === null) {
    const normalized = { ...schema };
    delete normalized.validations;
    return normalized;
  }
  return schema;
}

function validateValidationsField(
  schema: any,
  index: number,
  input: string,
): { message: string; line?: number } | null {
  if (!schema || typeof schema !== 'object') return null;

  const validations = schema.validations;
  if (validations === undefined || Array.isArray(validations)) return null;

  if (typeof validations === 'object' && !Array.isArray(validations)) {
    return handleValidationsObjectError(schema, validations, index, input);
  }

  return {
    message:
      `Schema ${index + 1} (field: "${schema.id || 'unknown'}"): Field "validations" must be an array or omitted. ` +
      `Found: ${typeof validations}. ` +
      `Example: [{"validation": "optional", "value": "true"}] or omit the field entirely.`,
    line: getValidationsLine(schema, input),
  };
}

function handleValidationsObjectError(
  schema: any,
  validations: any,
  index: number,
  input: string,
): { message: string; line?: number } | null {
  const keys = Object.keys(validations);
  const validKeys = ['optional', 'min', 'max', 'format', 'accept'];

  if (!keys.some((key) => validKeys.includes(key))) {
    return null;
  }

  const firstKey = keys[0];
  const value = validations[firstKey];
  const correctFormat = formatCorrectValidationsArray(firstKey, value);

  return {
    message:
      `Schema ${index + 1} (field: "${schema.id || 'unknown'}"): Field "validations" must be an array, not an object. ` +
      `Found: ${JSON.stringify(validations)}. ` +
      `Correct format: ${correctFormat}`,
    line: getValidationsLine(schema, input),
  };
}

function formatCorrectValidationsArray(key: string, value: any): string {
  if (key === 'optional') {
    const isTrue = value === true || value === 'true';
    return isTrue
      ? `[{"validation": "optional", "value": "true"}]`
      : `[{"validation": "optional", "value": "${value}"}]`;
  }
  return `[{"validation": "${key}", "value": "${value}"}]`;
}

function extractZodErrors(
  zodError: any,
  schema: any,
  index: number,
  input: string,
): { message: string; line?: number }[] {
  const issues = zodError.issues ?? zodError.errors;
  if (!issues) {
    return [
      {
        message: `Schema ${index + 1}: ${zodError.message}`,
        line: getLine('type', input),
      },
    ];
  }

  return issues.map((error: any) => {
    const fieldPath = error.path?.join('.') || '';
    const fieldName = fieldPath || error.path?.[0] || 'unknown';
    const errorMessage = enhanceZodErrorMessage(error, fieldName, schema);

    return {
      message: `Schema ${index + 1}: ${errorMessage}`,
      line: getLine(error.path?.[0] || '', input),
    };
  });
}

function enhanceZodErrorMessage(error: any, fieldName: string, schema: any): string {
  switch (error.code) {
    case 'invalid_type':
      return handleInvalidTypeError(error, fieldName, schema);

    case 'invalid_enum_value': {
      const options = error.options?.join(', ') || 'unknown options';
      return `Field "${fieldName}" has invalid value "${error.received}". Must be one of: ${options}.`;
    }

    case 'too_small':
      return handleTooSmallError(error, fieldName);

    case 'invalid_string':
      return `Field "${fieldName}" ${error.message.toLowerCase()}.`;

    case 'invalid_union':
      return `Field "${fieldName}" ${error.message}. Check that the structure matches the expected format.`;

    default:
      return error.message;
  }
}

function handleInvalidTypeError(error: any, fieldName: string, schema: any): string {
  if (error.received === 'null') {
    return `Field "${fieldName}" cannot be null. Use an empty array [] or omit the field instead.`;
  }

  if (error.expected === 'array' && error.received === 'object') {
    if (fieldName === 'validations') {
      return (
        `Field "validations" must be an array of validation objects, not a plain object. ` +
        `Example: [{"validation": "optional", "value": "true"}] or [{"validation": "min", "value": "5"}]. ` +
        `Found: ${JSON.stringify(schema.validations)}`
      );
    }
  }

  return `Field "${fieldName}" has invalid type. Expected ${error.expected}, but received ${error.received}.`;
}

function handleTooSmallError(error: any, fieldName: string): string {
  if (error.type === 'array') {
    return `Field "${fieldName}" array must have at least ${error.minimum} element(s).`;
  }
  return `Field "${fieldName}" must be at least ${error.minimum} character(s) long.`;
}

function buildValidationResult(
  errors: { message: string; line?: number }[],
  schemas: JobInputSchemaType[],
  schemasToValidate: any[],
): ValidationResult {
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      parsedSchemas: schemas.length > 0 ? schemas : undefined,
    };
  }

  if (schemasToValidate.length > 0 && schemas.length < schemasToValidate.length) {
    return {
      valid: false,
      errors: [{ message: 'Some schemas could not be validated. Please check the structure.' }],
      parsedSchemas: schemas.length > 0 ? schemas : undefined,
    };
  }

  return {
    valid: true,
    errors: [],
    parsedSchemas: schemas,
  };
}

function getLine(key: string, input: string): number | undefined {
  if (!key) return undefined;
  const searchKey = '"' + key + '"';
  const idx = input.indexOf(searchKey);
  if (idx === -1) return undefined;
  return input.slice(0, idx).split('\n').length;
}

function getValidationsLine(schema: any, input: string): number | undefined {
  const schemaId = schema.id || '';
  if (!schemaId) return getLine('validations', input);

  const idPattern = '"id":\\s*"' + schemaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"';
  const idMatch = input.match(new RegExp(idPattern));

  if (!idMatch || idMatch.index === undefined) return getLine('validations', input);

  const afterId = input.substring(idMatch.index);
  const validationsMatch = afterId.match(/"validations"\s*:/);

  if (!validationsMatch || validationsMatch.index === undefined) {
    return getLine('validations', input);
  }

  const absolutePos = idMatch.index + validationsMatch.index;
  return input.slice(0, absolutePos).split('\n').length;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InputSchemaValidator() {
  const [jsonInput, setJsonInput] = useState<string>(DEFAULT_SCHEMA);
  const { theme } = useTheme();
  const [selectedExample, setSelectedExample] = useState<string>('');

  const handleJsonInputChange = (value: string) => {
    setJsonInput(value);
    setSelectedExample('');
  };

  const validation = useMemo(() => validateSchemaWithZod(jsonInput), [jsonInput]);

  const handleSelectExample = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedExample(val);
    const found = EXAMPLES.find((ex) => ex.label === val);
    if (found) setJsonInput(found.value);
  };

  return (
    <div className="space-y-4">
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
                Schema is valid!
              </div>
              <div className="flex-1 overflow-auto">
                <JobInputsFormRenderer jobInputSchemas={validation.parsedSchemas || []} />
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
                          <span className="text-xs text-muted-foreground">(line {err.line}) </span>
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
  );
}
