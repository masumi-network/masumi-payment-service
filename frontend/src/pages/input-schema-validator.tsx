/* eslint-disable @typescript-eslint/no-explicit-any */

import { MainLayout } from '@/components/layout/MainLayout';
import Head from 'next/head';
import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from '@/lib/contexts/ThemeContext';

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

const SUPPORTED_TYPES = ['string', 'number', 'boolean', 'option', 'none'];
const VALIDATION_TYPES = ['min', 'max', 'format', 'optional'];
const STRING_FORMATS = ['email', 'url', 'nonempty'];
const NUMBER_FORMATS = ['integer'];

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
];

function validateMIP003Schema(input: string): {
  valid: boolean;
  errors: { message: string; line?: number }[];
  formatted?: string;
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

  // Helper to get line number for a key
  const getLine = (key: string) => {
    const idx = input.indexOf('"' + key + '"');
    if (idx === -1) return undefined;
    return input.slice(0, idx).split('\n').length;
  };

  // Required fields
  ['id', 'type', 'name'].forEach((field) => {
    if (!(field in parsed)) {
      errors.push({
        message: `Missing required field: ${field}`,
        line: getLine(field),
      });
    }
  });

  // Type check
  if (parsed.type && !SUPPORTED_TYPES.includes(parsed.type)) {
    errors.push({
      message: `Invalid type: ${parsed.type}. Must be one of ${SUPPORTED_TYPES.join(', ')}`,
      line: getLine('type'),
    });
  }

  // Option type: data.values must exist and be array
  if (parsed.type === 'option') {
    if (!parsed.data || !Array.isArray(parsed.data.values)) {
      errors.push({
        message: 'For type "option", data.values (array) is required',
        line: getLine('data'),
      });
    }
  }

  // Validations
  if (parsed.validations) {
    if (!Array.isArray(parsed.validations)) {
      errors.push({
        message: 'validations must be an array',
        line: getLine('validations'),
      });
    } else {
      parsed.validations.forEach((v: any, i: number) => {
        if (!v.validation || !VALIDATION_TYPES.includes(v.validation)) {
          errors.push({
            message: `Validation #${i + 1}: invalid validation type: ${v.validation}`,
            line: getLine('validations'),
          });
        }
        if (v.validation === 'format') {
          if (parsed.type === 'string' && !STRING_FORMATS.includes(v.value)) {
            errors.push({
              message: `Validation #${i + 1}: invalid string format: ${v.value}`,
              line: getLine('validations'),
            });
          }
          if (parsed.type === 'number' && !NUMBER_FORMATS.includes(v.value)) {
            errors.push({
              message: `Validation #${i + 1}: invalid number format: ${v.value}`,
              line: getLine('validations'),
            });
          }
        }
        // min/max should be numbers for string/number/option
        if (v.validation === 'min' || v.validation === 'max') {
          if (['string', 'number', 'option'].includes(parsed.type)) {
            if (isNaN(Number(v.value))) {
              errors.push({
                message: `Validation #${i + 1}: min/max value should be a number`,
                line: getLine('validations'),
              });
            }
          }
        }
      });
    }
  }

  // Data field checks
  if (parsed.data) {
    if (typeof parsed.data !== 'object') {
      errors.push({ message: 'data must be an object', line: getLine('data') });
    }
    if (parsed.data.values && !Array.isArray(parsed.data.values)) {
      errors.push({
        message: 'data.values must be an array',
        line: getLine('data'),
      });
    }
  }

  // If any errors, return them
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // If valid, return formatted JSON
  return {
    valid: true,
    errors: [],
    formatted: JSON.stringify(parsed, null, 2),
  };
}

export default function InputSchemaValidatorPage() {
  const [jsonInput, setJsonInput] = useState<string>(DEFAULT_SCHEMA);
  const { theme } = useTheme();
  const [selectedExample, setSelectedExample] = useState<string>('');

  // Memoize validation for performance
  const validation = useMemo(
    () => validateMIP003Schema(jsonInput),
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
            specification in real time.
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
                onChange={(value) => setJsonInput(value ?? '')}
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
                <div className="bg-muted rounded border text-xs overflow-x-auto h-[600px] flex-1">
                  <MonacoEditor
                    height="600px"
                    defaultLanguage="json"
                    value={validation.formatted}
                    onChange={() => {}}
                    theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 14,
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      formatOnPaste: true,
                      formatOnType: true,
                      automaticLayout: true,
                      readOnly: true,
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col gap-2 h-full">
                <div className="text-destructive font-semibold mb-2 h-[30px] flex items-center">
                  Schema is invalid:
                </div>
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
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
