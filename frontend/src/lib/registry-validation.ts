export const REGISTRY_LIMITS = {
  agentName: 250,
  apiBaseUrl: 250,
  authorContact: 250,
  authorName: 250,
  capabilityName: 250,
  capabilityVersion: 250,
  description: 250,
  exampleOutputCount: 25,
  exampleOutputMimeType: 60,
  exampleOutputName: 60,
  exampleOutputUrl: 250,
  legalUrl: 250,
  lovelaceAmount: 25,
  pricingOptionCount: 5,
  tag: 63,
  tagCount: 15,
  walletReference: 250,
} as const;

export const REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;
