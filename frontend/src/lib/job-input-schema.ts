import { z } from 'zod';

// Enums matching sokosumi's implementation
export enum ValidJobInputTypes {
  STRING = 'string',
  TEXTAREA = 'textarea',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  OPTION = 'option',
  FILE = 'file',
  EMAIL = 'email',
  PASSWORD = 'password',
  TEL = 'tel',
  URL = 'url',
  DATE = 'date',
  DATETIME_LOCAL = 'datetime-local',
  TIME = 'time',
  MONTH = 'month',
  WEEK = 'week',
  COLOR = 'color',
  RANGE = 'range',
  HIDDEN = 'hidden',
  SEARCH = 'search',
  CHECKBOX = 'checkbox',
  RADIO = 'radio',
  NONE = 'none',
}

export enum ValidJobInputValidationTypes {
  MIN = 'min',
  MAX = 'max',
  FORMAT = 'format',
  OPTIONAL = 'optional',
  ACCEPT = 'accept',
}

export enum ValidJobInputFormatValues {
  URL = 'url',
  EMAIL = 'email',
  INTEGER = 'integer',
  NON_EMPTY = 'nonempty',
  TEL_PATTERN = 'tel',
}

// Validation schemas
export const optionalValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.OPTIONAL]),
  value: z.enum(['true', 'false'] as const),
});

export const minValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.MIN]),
  value: z.coerce.number().int().min(0),
});

export const maxValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.MAX]),
  value: z.coerce.number().int().min(0),
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

export const formatTelPatternValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.FORMAT]),
  value: z.enum([ValidJobInputFormatValues.TEL_PATTERN]),
});

export const acceptValidationSchema = z.object({
  validation: z.enum([ValidJobInputValidationTypes.ACCEPT]),
  value: z.string(),
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
    .array(optionalValidationSchema.or(minValidationSchema).or(maxValidationSchema))
    .optional(),
});

export const jobInputFileSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.FILE]),
  name: z.string().min(1),
  data: z
    .object({
      outputFormat: z.enum(['url', 'filename']).optional(),
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema.or(acceptValidationSchema)).optional(),
});

// New: Email input
export const jobInputEmailSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.EMAIL]),
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
        .or(formatEmailValidationSchema),
    )
    .optional(),
});

// New: Password input
export const jobInputPasswordSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.PASSWORD]),
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

// New: Tel input
export const jobInputTelSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.TEL]),
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
        .or(formatTelPatternValidationSchema),
    )
    .optional(),
});

// New: URL input
export const jobInputUrlSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.URL]),
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
        .or(formatUrlValidationSchema),
    )
    .optional(),
});

// New: Date input
export const jobInputDateSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.DATE]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema.or(formatNonEmptyValidationSchema)).optional(),
});

// New: Datetime-local input
export const jobInputDatetimeLocalSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.DATETIME_LOCAL]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema.or(formatNonEmptyValidationSchema)).optional(),
});

// New: Time input
export const jobInputTimeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.TIME]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema.or(formatNonEmptyValidationSchema)).optional(),
});

// New: Month input
export const jobInputMonthSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.MONTH]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema.or(formatNonEmptyValidationSchema)).optional(),
});

// New: Week input
export const jobInputWeekSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.WEEK]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema.or(formatNonEmptyValidationSchema)).optional(),
});

// New: Color input (hex color picker)
export const jobInputColorSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.COLOR]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
      default: z.string().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema).optional(),
});

// New: Range slider input
export const jobInputRangeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.RANGE]),
  name: z.string().min(1),
  data: z
    .object({
      min: z.coerce.number().optional(),
      max: z.coerce.number().optional(),
      step: z.coerce.number().optional(),
      description: z.string().optional(),
      default: z.coerce.number().optional(),
    })
    .optional(),
  validations: z
    .array(optionalValidationSchema.or(minValidationSchema).or(maxValidationSchema))
    .optional(),
});

// New: Hidden input (no visible UI — passes a fixed value)
export const jobInputHiddenSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.HIDDEN]),
  name: z.string().min(1),
  data: z.object({
    value: z.string().min(1),
  }),
});

// New: Search input
export const jobInputSearchSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.SEARCH]),
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

export const jobInputCheckboxSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.CHECKBOX]),
  name: z.string().min(1),
  data: z
    .object({
      description: z.string().optional(),
      default: z.boolean().optional(),
    })
    .optional(),
  validations: z.array(optionalValidationSchema).optional(),
});

// New: Radio button group input (single selection from values list)
export const jobInputRadioSchema = z.object({
  id: z.string().min(1),
  type: z.enum([ValidJobInputTypes.RADIO]),
  name: z.string().min(1),
  data: z.object({
    values: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  validations: z.array(optionalValidationSchema).optional(),
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
  .or(jobInputFileSchema)
  .or(jobInputEmailSchema)
  .or(jobInputPasswordSchema)
  .or(jobInputTelSchema)
  .or(jobInputUrlSchema)
  .or(jobInputDateSchema)
  .or(jobInputDatetimeLocalSchema)
  .or(jobInputTimeSchema)
  .or(jobInputMonthSchema)
  .or(jobInputWeekSchema)
  .or(jobInputColorSchema)
  .or(jobInputRangeSchema)
  .or(jobInputHiddenSchema)
  .or(jobInputSearchSchema)
  .or(jobInputCheckboxSchema)
  .or(jobInputRadioSchema)
  .or(jobInputNoneSchema);

export type JobInputSchemaType = z.infer<typeof jobInputSchema>;
export type JobInputStringSchemaType = z.infer<typeof jobInputStringSchema>;
export type JobInputTextareaSchemaType = z.infer<typeof jobInputTextareaSchema>;
export type JobInputNumberSchemaType = z.infer<typeof jobInputNumberSchema>;
export type JobInputBooleanSchemaType = z.infer<typeof jobInputBooleanSchema>;
export type JobInputOptionSchemaType = z.infer<typeof jobInputOptionSchema>;
export type JobInputFileSchemaType = z.infer<typeof jobInputFileSchema>;
export type JobInputEmailSchemaType = z.infer<typeof jobInputEmailSchema>;
export type JobInputPasswordSchemaType = z.infer<typeof jobInputPasswordSchema>;
export type JobInputTelSchemaType = z.infer<typeof jobInputTelSchema>;
export type JobInputUrlSchemaType = z.infer<typeof jobInputUrlSchema>;
export type JobInputDateSchemaType = z.infer<typeof jobInputDateSchema>;
export type JobInputDatetimeLocalSchemaType = z.infer<typeof jobInputDatetimeLocalSchema>;
export type JobInputTimeSchemaType = z.infer<typeof jobInputTimeSchema>;
export type JobInputMonthSchemaType = z.infer<typeof jobInputMonthSchema>;
export type JobInputWeekSchemaType = z.infer<typeof jobInputWeekSchema>;
export type JobInputColorSchemaType = z.infer<typeof jobInputColorSchema>;
export type JobInputRangeSchemaType = z.infer<typeof jobInputRangeSchema>;
export type JobInputHiddenSchemaType = z.infer<typeof jobInputHiddenSchema>;
export type JobInputSearchSchemaType = z.infer<typeof jobInputSearchSchema>;
export type JobInputCheckboxSchemaType = z.infer<typeof jobInputCheckboxSchema>;
export type JobInputRadioSchemaType = z.infer<typeof jobInputRadioSchema>;
export type JobInputNoneSchemaType = z.infer<typeof jobInputNoneSchema>;

// Form schema generation
export const makeZodSchemaFromJobInputSchema = (jobInputSchema: JobInputSchemaType) => {
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
    case ValidJobInputTypes.FILE:
      return makeZodSchemaFromJobInputFileSchema(jobInputSchema);
    case ValidJobInputTypes.EMAIL:
      return makeZodSchemaFromJobInputEmailSchema(jobInputSchema);
    case ValidJobInputTypes.PASSWORD:
      return makeZodSchemaFromJobInputPasswordSchema(jobInputSchema);
    case ValidJobInputTypes.TEL:
      return makeZodSchemaFromJobInputTelSchema(jobInputSchema);
    case ValidJobInputTypes.URL:
      return makeZodSchemaFromJobInputUrlSchema(jobInputSchema);
    case ValidJobInputTypes.DATE:
    case ValidJobInputTypes.DATETIME_LOCAL:
    case ValidJobInputTypes.TIME:
    case ValidJobInputTypes.MONTH:
    case ValidJobInputTypes.WEEK:
      return makeZodSchemaFromJobInputDateSchema(jobInputSchema);
    case ValidJobInputTypes.COLOR:
      return makeZodSchemaFromJobInputColorSchema(jobInputSchema);
    case ValidJobInputTypes.RANGE:
      return makeZodSchemaFromJobInputRangeSchema(jobInputSchema);
    case ValidJobInputTypes.HIDDEN:
      return z.string();
    case ValidJobInputTypes.SEARCH:
      return makeZodSchemaFromJobInputSearchSchema(jobInputSchema);
    case ValidJobInputTypes.CHECKBOX:
      return makeZodSchemaFromJobInputCheckboxSchema(jobInputSchema);
    case ValidJobInputTypes.RADIO:
      return makeZodSchemaFromJobInputRadioSchema(jobInputSchema);
    case ValidJobInputTypes.NONE:
      return z.never().nullable();
  }
};

const makeZodSchemaFromJobInputStringSchema = (jobInputStringSchema: JobInputStringSchemaType) => {
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

const makeZodSchemaFromJobInputNumberSchema = (jobInputNumberSchema: JobInputNumberSchemaType) => {
  const { validations } = jobInputNumberSchema;
  const defaultSchema = z.coerce.number();
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

const makeZodSchemaFromJobInputOptionSchema = (jobInputOptionSchema: JobInputOptionSchemaType) => {
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

const makeZodSchemaFromJobInputFileSchema = (jobInputFileSchema: JobInputFileSchemaType) => {
  const { validations } = jobInputFileSchema;
  const defaultSchema = z.string();
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  const schema = validations.reduce((acc, cur) => {
    const { validation, value: _value } = cur;
    switch (validation) {
      case ValidJobInputValidationTypes.OPTIONAL:
        canBeOptional = _value === 'true';
        return acc;
      default:
        return acc;
    }
  }, defaultSchema);

  return canBeOptional ? schema.optional() : schema;
};

const makeZodSchemaFromJobInputEmailSchema = (jobInputEmailSchema: JobInputEmailSchemaType) => {
  const { validations } = jobInputEmailSchema;
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

const makeZodSchemaFromJobInputPasswordSchema = (
  jobInputPasswordSchema: JobInputPasswordSchemaType,
) => {
  const { validations } = jobInputPasswordSchema;
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

const makeZodSchemaFromJobInputTelSchema = (jobInputTelSchema: JobInputTelSchemaType) => {
  const { validations } = jobInputTelSchema;
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
          case ValidJobInputFormatValues.TEL_PATTERN:
            return acc.regex(/^\+?[\d\s\-()]+$/, 'Invalid phone number format');
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

const makeZodSchemaFromJobInputUrlSchema = (jobInputUrlSchema: JobInputUrlSchemaType) => {
  const { validations } = jobInputUrlSchema;
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

// Shared handler for date/datetime-local/time/month/week — all store as strings
const makeZodSchemaFromJobInputDateSchema = (
  jobInputDateSchema:
    | JobInputDateSchemaType
    | JobInputDatetimeLocalSchemaType
    | JobInputTimeSchemaType
    | JobInputMonthSchemaType
    | JobInputWeekSchemaType,
) => {
  const { validations } = jobInputDateSchema;
  const defaultSchema = z.string();
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  const schema = validations.reduce((acc, cur) => {
    const { validation, value } = cur;
    switch (validation) {
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

const makeZodSchemaFromJobInputColorSchema = (jobInputColorSchema: JobInputColorSchemaType) => {
  const { validations } = jobInputColorSchema;
  const defaultSchema = z.string();
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  validations.forEach((cur) => {
    if (cur.validation === ValidJobInputValidationTypes.OPTIONAL) {
      canBeOptional = cur.value === 'true';
    }
  });

  return canBeOptional ? defaultSchema.optional() : defaultSchema;
};

const makeZodSchemaFromJobInputRangeSchema = (jobInputRangeSchema: JobInputRangeSchemaType) => {
  const { validations } = jobInputRangeSchema;
  const defaultSchema = z.coerce.number();
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

const makeZodSchemaFromJobInputSearchSchema = (jobInputSearchSchema: JobInputSearchSchemaType) => {
  const { validations } = jobInputSearchSchema;
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

const makeZodSchemaFromJobInputCheckboxSchema = (
  jobInputCheckboxSchema: JobInputCheckboxSchemaType,
) => {
  const { validations } = jobInputCheckboxSchema;
  const defaultSchema = z.boolean();
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  validations.forEach((cur) => {
    if (cur.validation === ValidJobInputValidationTypes.OPTIONAL) {
      canBeOptional = cur.value === 'true';
    }
  });

  return canBeOptional ? defaultSchema.optional() : defaultSchema;
};

const makeZodSchemaFromJobInputRadioSchema = (jobInputRadioSchema: JobInputRadioSchemaType) => {
  const {
    data: { values },
    validations,
  } = jobInputRadioSchema;
  const defaultSchema = z
    .number()
    .int()
    .nonnegative()
    .max(values.length - 1);
  if (!validations) return defaultSchema;

  let canBeOptional: boolean = false;
  validations.forEach((cur) => {
    if (cur.validation === ValidJobInputValidationTypes.OPTIONAL) {
      canBeOptional = cur.value === 'true';
    }
  });

  return canBeOptional ? defaultSchema.optional() : defaultSchema;
};

// Helper functions
export const isOptional = (jobInputSchema: JobInputSchemaType): boolean => {
  if (!('validations' in jobInputSchema) || !jobInputSchema.validations) return false;
  return jobInputSchema.validations.some(
    (v) => v.validation === ValidJobInputValidationTypes.OPTIONAL && v.value === 'true',
  );
};

export const isSingleOption = (jobInputSchema: JobInputSchemaType): boolean => {
  if (jobInputSchema.type !== ValidJobInputTypes.OPTION) return false;
  if (!('validations' in jobInputSchema) || !jobInputSchema.validations) return false;

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
    case ValidJobInputTypes.FILE:
      return null;
    case ValidJobInputTypes.EMAIL:
      return '';
    case ValidJobInputTypes.PASSWORD:
      return '';
    case ValidJobInputTypes.TEL:
      return '';
    case ValidJobInputTypes.URL:
      return '';
    case ValidJobInputTypes.DATE:
      return '';
    case ValidJobInputTypes.DATETIME_LOCAL:
      return '';
    case ValidJobInputTypes.TIME:
      return '';
    case ValidJobInputTypes.MONTH:
      return '';
    case ValidJobInputTypes.WEEK:
      return '';
    case ValidJobInputTypes.SEARCH:
      return '';
    case ValidJobInputTypes.COLOR:
      // Use schema-defined default if available, otherwise fall back to black
      return jobInputSchema.data?.default ?? '#000000';
    case ValidJobInputTypes.RANGE: {
      const rangeData = jobInputSchema.data;
      return rangeData?.default ?? rangeData?.min ?? 0;
    }
    case ValidJobInputTypes.HIDDEN:
      // Hidden inputs must return their fixed value for form submission
      return jobInputSchema.data.value;
    case ValidJobInputTypes.CHECKBOX:
      // Use schema-defined default if available
      return jobInputSchema.data?.default ?? false;
    case ValidJobInputTypes.RADIO: {
      // Pre-select the option whose label matches data.default
      const radioDefault = jobInputSchema.data?.default;
      if (radioDefault !== undefined) {
        const idx = jobInputSchema.data.values.indexOf(radioDefault);
        return idx >= 0 ? idx : null;
      }
      return null;
    }
    case ValidJobInputTypes.NONE:
      return null;
  }
};
