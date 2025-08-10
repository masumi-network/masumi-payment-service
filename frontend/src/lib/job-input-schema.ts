import { z } from 'zod';

// Enums matching sokosumi's implementation
export enum ValidJobInputTypes {
  STRING = 'string',
  TEXTAREA = 'textarea',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  OPTION = 'option',
  NONE = 'none',
}

export enum ValidJobInputValidationTypes {
  MIN = 'min',
  MAX = 'max',
  FORMAT = 'format',
  OPTIONAL = 'optional',
}

export enum ValidJobInputFormatValues {
  URL = 'url',
  EMAIL = 'email',
  INTEGER = 'integer',
  NON_EMPTY = 'nonempty',
}

// Validation schemas
export const optionalValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.OPTIONAL]),
  value: z.enum(['true', 'false'] as const),
});

export const minValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.MIN]),
  value: z.number({ coerce: true }).int().min(0),
});

export const maxValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.MAX]),
  value: z.number({ coerce: true }).int().min(0),
});

export const formatUrlValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.FORMAT]),
  value: z.enum([ValidJobInputFormatValues.URL]),
});

export const formatEmailValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.FORMAT]),
  value: z.enum([ValidJobInputFormatValues.EMAIL]),
});

export const formatIntegerValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.FORMAT]),
  value: z.enum([ValidJobInputFormatValues.INTEGER]),
});

export const formatNonEmptyValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.FORMAT]),
  value: z.enum([ValidJobInputFormatValues.NON_EMPTY]),
});

// Job input schemas
export const jobInputStringSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.STRING]),
  name: z.string().min(1),
  data: z
    .object({
      placeholder: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  validations: z
    .array(
      optionalValidationSchema
        .or(minValidationSchema)
        .or(maxValidationSchema)
        .or(formatNonEmptyValidationSchema)
        .or(formatUrlValidationSchema)
        .or(formatEmailValidationSchema),
    )
    .optional(),
});

export const jobInputTextareaSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.TEXTAREA]),
  name: z.string().min(1),
  data: z
    .object({
      placeholder: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  validations: z
    .array(
      optionalValidationSchema
        .or(minValidationSchema)
        .or(maxValidationSchema)
        .or(formatNonEmptyValidationSchema),
    )
    .optional(),
});

export const jobInputNumberSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.NUMBER]),
  name: z.string().min(1),
  data: z
    .object({
      placeholder: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  validations: z
    .array(
      optionalValidationSchema
        .or(minValidationSchema)
        .or(maxValidationSchema)
        .or(formatIntegerValidationSchema),
    )
    .optional(),
});

export const jobInputBooleanSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.BOOLEAN]),
  name: z.string().min(1),
  data: z
    .object({
      placeholder: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema).optional(),
});

export const jobInputOptionSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.OPTION]),
  name: z.string().min(1),
  data: z.object({
    values: z.array(z.string().min(1)).min(1),
    placeholder: z.string().optional(),
    description: z.string().optional(),
  }),
  validations: z
    .array(
      optionalValidationSchema.or(minValidationSchema).or(maxValidationSchema),
    )
    .optional(),
});

export const jobInputNoneSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.NONE]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().min(1).optional(),
    })
    .optional(),
});

// Union schema for all job input types
export const jobInputSchema = jobInputStringSchema
  .or(jobInputTextareaSchema)
  .or(jobInputNumberSchema)
  .or(jobInputBooleanSchema)
  .or(jobInputOptionSchema)
  .or(jobInputNoneSchema);

export type JobInputSchemaType = z.infer<typeof jobInputSchema>;
export type JobInputStringSchemaType = z.infer<typeof jobInputStringSchema>;
export type JobInputTextareaSchemaType = z.infer<typeof jobInputTextareaSchema>;
export type JobInputNumberSchemaType = z.infer<typeof jobInputNumberSchema>;
export type JobInputBooleanSchemaType = z.infer<typeof jobInputBooleanSchema>;
export type JobInputOptionSchemaType = z.infer<typeof jobInputOptionSchema>;
export type JobInputNoneSchemaType = z.infer<typeof jobInputNoneSchema>;

// Form schema generation (based on sokosumi's approach)
export const makeZodSchemaFromJobInputSchema = (
  jobInputSchema: JobInputSchemaType,
) => {
  switch (jobInputSchema.type) {
    case ValidJobInputTypes.STRING:
      return makeZodSchemaFromJobInputStringSchema(jobInputSchema);
    case ValidJobInputTypes.TEXTAREA:
      return makeZodSchemaFromJobInputTextareaSchema(jobInputSchema);
    case ValidJobInputTypes.NUMBER:
      return makeZodSchemaFromJobInputNumberSchema(jobInputSchema);
    case ValidJobInputTypes.BOOLEAN:
      return makeZodSchemaFromJobInputBooleanSchema();
    case ValidJobInputTypes.OPTION:
      return makeZodSchemaFromJobInputOptionSchema(jobInputSchema);
    case ValidJobInputTypes.NONE:
      return z.never().nullable();
  }
};

const makeZodSchemaFromJobInputStringSchema = (
  jobInputStringSchema: JobInputStringSchemaType,
) => {
  const { validations } = jobInputStringSchema;
  const defaultSchema = z.string();
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  const schema = validations.reduce((acc, cur) => {
    const { validation, value } = cur;
    switch (validation) {
      case ValidJobInputValidationTypes.MIN:
        return acc.min(value);
      case ValidJobInputValidationTypes.MAX:
        return acc.max(value);
      case ValidJobInputValidationTypes.FORMAT:
        switch (value) {
          case ValidJobInputFormatValues.URL:
            return acc.url();
          case ValidJobInputFormatValues.EMAIL:
            return acc.email();
          case ValidJobInputFormatValues.NON_EMPTY:
            return acc.min(1);
          default:
            return acc;
        }
      case ValidJobInputValidationTypes.OPTIONAL:
        canBeOptional = value === 'true';
        return acc;
    }
  }, defaultSchema);

  return canBeOptional ? schema.optional() : schema;
};

const makeZodSchemaFromJobInputTextareaSchema = (
  jobInputTextareaSchema: JobInputTextareaSchemaType,
) => {
  const { validations } = jobInputTextareaSchema;
  const defaultSchema = z.string();
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  const schema = validations.reduce((acc, cur) => {
    const { validation, value } = cur;
    switch (validation) {
      case ValidJobInputValidationTypes.MIN:
        return acc.min(value);
      case ValidJobInputValidationTypes.MAX:
        return acc.max(value);
      case ValidJobInputValidationTypes.FORMAT:
        switch (value) {
          case ValidJobInputFormatValues.NON_EMPTY:
            return acc.min(1);
          default:
            return acc;
        }
      case ValidJobInputValidationTypes.OPTIONAL:
        canBeOptional = value === 'true';
        return acc;
    }
  }, defaultSchema);

  return canBeOptional ? schema.optional() : schema;
};

const makeZodSchemaFromJobInputNumberSchema = (
  jobInputNumberSchema: JobInputNumberSchemaType,
) => {
  const { validations } = jobInputNumberSchema;
  const defaultSchema = z.number({ coerce: true });
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  const schema = validations.reduce((acc, cur) => {
    const { validation, value } = cur;
    switch (validation) {
      case ValidJobInputValidationTypes.MIN:
        return acc.min(value);
      case ValidJobInputValidationTypes.MAX:
        return acc.max(value);
      case ValidJobInputValidationTypes.FORMAT:
        switch (value) {
          case ValidJobInputFormatValues.INTEGER:
            return acc.int();
          default:
            return acc;
        }
      case ValidJobInputValidationTypes.OPTIONAL:
        canBeOptional = value === 'true';
        return acc;
    }
  }, defaultSchema);

  return canBeOptional ? schema.optional() : schema;
};

const makeZodSchemaFromJobInputBooleanSchema = () => {
  return z.boolean();
};

const makeZodSchemaFromJobInputOptionSchema = (
  jobInputOptionSchema: JobInputOptionSchemaType,
) => {
  const {
    data: { values },
    validations,
  } = jobInputOptionSchema;
  const defaultSchema = z.array(
    z
      .number()
      .int()
      .nonnegative()
      .max(values.length - 1),
  );
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  const schema = validations.reduce((acc, cur) => {
    const { validation, value } = cur;
    switch (validation) {
      case ValidJobInputValidationTypes.MIN:
        return acc.min(value);
      case ValidJobInputValidationTypes.MAX:
        return acc.max(value);
      case ValidJobInputValidationTypes.OPTIONAL:
        canBeOptional = value === 'true';
        return acc;
    }
  }, defaultSchema);

  return canBeOptional ? schema.optional() : schema;
};

// Helper functions
export const isOptional = (jobInputSchema: JobInputSchemaType): boolean => {
  if (!('validations' in jobInputSchema) || !jobInputSchema.validations)
    return false;
  return jobInputSchema.validations.some(
    (v) =>
      v.validation === ValidJobInputValidationTypes.OPTIONAL &&
      v.value === 'true',
  );
};

export const isSingleOption = (jobInputSchema: JobInputSchemaType): boolean => {
  if (jobInputSchema.type !== ValidJobInputTypes.OPTION) return false;
  if (!('validations' in jobInputSchema) || !jobInputSchema.validations)
    return false;

  const minValidation = jobInputSchema.validations.find(
    (v) => v.validation === ValidJobInputValidationTypes.MIN,
  );
  const maxValidation = jobInputSchema.validations.find(
    (v) => v.validation === ValidJobInputValidationTypes.MAX,
  );

  return minValidation?.value === 1 && maxValidation?.value === 1;
};

export const getDefaultValue = (jobInputSchema: JobInputSchemaType) => {
  const { type } = jobInputSchema;
  switch (type) {
    case ValidJobInputTypes.STRING:
      return '';
    case ValidJobInputTypes.TEXTAREA:
      return '';
    case ValidJobInputTypes.BOOLEAN:
      return false;
    case ValidJobInputTypes.NUMBER:
      return null;
    case ValidJobInputTypes.OPTION:
      return [];
    case ValidJobInputTypes.NONE:
      return null;
  }
};
