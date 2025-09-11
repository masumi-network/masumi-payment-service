import { describe, it, expect } from '@jest/globals';
import { generateInvoicePDF, generateInvoicePDFBase64 } from './pdf-generator';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('PDF Generator', () => {
  const mockInvoiceData = {
    signature: 'mock-signature',
    key: 'mock-key',
    walletAddress:
      'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
    validUntil: Date.now() + 1000 * 60 * 60,
    blockchainIdentifier: 'test-blockchain-id',
    action: 'generate_invoice' as const,
    invoiceTitle: 'Agent Payment Invoice',
    invoiceDescription: 'Payment for AI agent services',
    invoiceDate: '2025-01-15',
    invoiceGreetings: 'Thank you for using our AI agent services!',
    invoiceClosing: 'We appreciate your prompt payment.',
    invoiceSignature: 'MASUMI AI Team',
    invoiceLogo: '',
    invoiceFooter:
      'This is a computer-generated invoice for AI agent services.',
    invoiceTerms: 'Payment is due within 30 days of invoice date.',
    invoicePrivacy:
      'Your privacy is important to us. We will not share your information.',
    invoiceDisclaimer: 'This invoice is subject to our terms and conditions.',
    vatRate: 0.19, // 19% VAT
    invoiceItems: [
      {
        name: 'AI Agent Service Usage',
        quantity: 1,
        price: 50.0,
        currency: 'USDM',
      },
    ],
    seller: {
      country: 'United States',
      city: 'San Francisco',
      zipCode: '94105',
      street: 'AI Boulevard',
      streetNumber: '42',
      email: 'billing@masumi.ai',
      phone: '+1 (555) 628-7864',
      name: 'MASUMI AI Team',
      companyName: 'MASUMI AI Services LLC',
      vatNumber: 'US987654321',
    },
    buyer: {
      country: 'Germany',
      city: 'Berlin',
      zipCode: '10115',
      street: 'Muster Straße',
      streetNumber: '42',
      email: 'contact@client-company.de',
      phone: '+49 30 12345678',
      name: 'Jane Smith',
      companyName: 'Client Company GmbH',
      vatNumber: 'DE987654321',
    },
  };

  it('should generate PDF buffer', async () => {
    const pdfBuffer = await generateInvoicePDF(mockInvoiceData);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Check PDF magic number (first 4 bytes should be %PDF)
    const pdfSignature = pdfBuffer.subarray(0, 4).toString();
    expect(pdfSignature).toBe('%PDF');
  });

  it('should generate PDF as base64 string', async () => {
    const pdfBase64 = await generateInvoicePDFBase64(mockInvoiceData);

    expect(typeof pdfBase64).toBe('string');
    expect(pdfBase64.length).toBeGreaterThan(0);

    // Verify it's valid base64
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const pdfSignature = pdfBuffer.subarray(0, 4).toString();
    expect(pdfSignature).toBe('%PDF');
  });

  it('should save an example PDF file', async () => {
    const pdfBuffer = await generateInvoicePDF(mockInvoiceData);

    // Create output directory if it doesn't exist
    const outputDir = join(process.cwd(), 'test-output');
    mkdirSync(outputDir, { recursive: true });

    // Save PDF to file
    const outputPath = join(outputDir, 'example-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);

    console.log(`Example PDF saved to: ${outputPath}`);

    // Verify file was created and has content
    expect(pdfBuffer.length).toBeGreaterThan(1000); // PDF should be reasonably sized
  });

  it('should handle invoice with minimal data', async () => {
    const minimalInvoiceData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-minimal',
      action: 'generate_invoice' as const,
      seller: {
        country: 'US',
        city: 'New York',
        zipCode: '10001',
        street: 'Main St',
        streetNumber: '1',
        email: null,
        phone: null,
        name: 'Test Seller',
        companyName: null,
        vatNumber: null,
      },
      buyer: {
        country: 'DE',
        city: 'Munich',
        zipCode: '80331',
        street: 'Test Str',
        streetNumber: '1',
        email: null,
        phone: null,
        name: null,
        companyName: 'Test Buyer GmbH',
        vatNumber: null,
      },
    };

    const pdfBuffer = await generateInvoicePDF(minimalInvoiceData);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save minimal example too
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'minimal-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);

    console.log(`Minimal PDF example saved to: ${outputPath}`);
  });

  it('should handle VAT included in price (global setting)', async () => {
    const vatIncludedData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-vat-included',
      action: 'generate_invoice' as const,
      invoiceTitle: 'VAT Included Invoice',
      vatRate: 0.19, // 19% VAT
      vatIsIncludedInThePrice: true,
      invoiceItems: [
        {
          name: 'Product with VAT included',
          quantity: 2,
          price: 119.0, // Price includes 19% VAT (net: 100, VAT: 19)
          currency: 'EUR',
        },
        {
          name: 'Service with VAT included',
          quantity: 1,
          price: 59.5, // Price includes 19% VAT (net: 50, VAT: 9.5)
          currency: 'EUR',
        },
      ],
      seller: {
        country: 'Germany',
        city: 'Berlin',
        zipCode: '10115',
        street: 'VAT Street',
        streetNumber: '1',
        email: 'seller@test.com',
        phone: null,
        name: 'VAT Test Seller',
        companyName: 'VAT Test GmbH',
        vatNumber: 'DE123456789',
      },
      buyer: {
        country: 'Germany',
        city: 'Munich',
        zipCode: '80331',
        street: 'Buyer St',
        streetNumber: '2',
        email: null,
        phone: null,
        name: null,
        companyName: 'Buyer GmbH',
        vatNumber: 'DE987654321',
      },
    };

    const pdfBuffer = await generateInvoicePDF(vatIncludedData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'vat-included-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`VAT included example saved to: ${outputPath}`);
  });

  it('should handle mixed VAT inclusion scenarios', async () => {
    const mixedVatData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-mixed-vat',
      action: 'generate_invoice' as const,
      invoiceTitle: 'Mixed VAT Invoice',
      vatRate: 0.19, // Default 19% VAT
      vatIsIncludedInThePrice: false, // Default: VAT not included
      invoiceItems: [
        {
          name: 'Product (VAT excluded)',
          quantity: 1,
          price: 100.0, // Net price, VAT will be added
          currency: 'EUR',
        },
        {
          name: 'Service (VAT included override)',
          quantity: 2,
          price: 59.5, // Price includes VAT
          currency: 'EUR',
          vatIsIncludedInThePriceOverride: true,
        },
        {
          name: 'Digital Product (7% VAT, excluded)',
          quantity: 1,
          price: 50.0, // Net price
          currency: 'EUR',
          vatRateOverride: 0.07,
        },
        {
          name: 'Premium Service (7% VAT, included)',
          quantity: 1,
          price: 107.0, // Price includes 7% VAT (net: 100, VAT: 7)
          currency: 'EUR',
          vatRateOverride: 0.07,
          vatIsIncludedInThePriceOverride: true,
        },
      ],
      seller: {
        country: 'Germany',
        city: 'Berlin',
        zipCode: '10115',
        street: 'Mixed VAT Street',
        streetNumber: '1',
        email: 'mixed@test.com',
        phone: null,
        name: 'Mixed VAT Seller',
        companyName: 'Mixed VAT GmbH',
        vatNumber: 'DE123456789',
      },
      buyer: {
        country: 'Germany',
        city: 'Munich',
        zipCode: '80331',
        street: 'Buyer St',
        streetNumber: '2',
        email: null,
        phone: null,
        name: null,
        companyName: 'Mixed Buyer GmbH',
        vatNumber: 'DE987654321',
      },
    };

    const pdfBuffer = await generateInvoicePDF(mixedVatData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'mixed-vat-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Mixed VAT example saved to: ${outputPath}`);
  });

  it('should handle different VAT rates with VAT included', async () => {
    const multiVatIncludedData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-multi-vat-included',
      action: 'generate_invoice' as const,
      invoiceTitle: 'Multiple VAT Rates (Included)',
      vatRate: 0.19, // Default 19% VAT
      vatIsIncludedInThePrice: true, // Default: VAT included
      invoiceItems: [
        {
          name: 'Standard Rate Product (19%)',
          quantity: 1,
          price: 119.0, // Includes 19% VAT (net: 100, VAT: 19)
          currency: 'EUR',
        },
        {
          name: 'Another Standard Product (19%)',
          quantity: 2,
          price: 59.5, // Includes 19% VAT (net: 50, VAT: 9.5 each)
          currency: 'EUR',
        },
        {
          name: 'Reduced Rate Service (7%)',
          quantity: 1,
          price: 107.0, // Includes 7% VAT (net: 100, VAT: 7)
          currency: 'EUR',
          vatRateOverride: 0.07,
        },
        {
          name: 'Books (7% reduced rate)',
          quantity: 3,
          price: 21.4, // Includes 7% VAT (net: 20, VAT: 1.4 each)
          currency: 'EUR',
          vatRateOverride: 0.07,
        },
        {
          name: 'Zero-rated Export',
          quantity: 1,
          price: 100.0, // No VAT
          currency: 'EUR',
          vatRateOverride: 0.0,
        },
      ],
      seller: {
        country: 'Germany',
        city: 'Berlin',
        zipCode: '10115',
        street: 'Multi VAT Street',
        streetNumber: '1',
        email: 'multivat@test.com',
        phone: null,
        name: 'Multi VAT Seller',
        companyName: 'Multi VAT GmbH',
        vatNumber: 'DE123456789',
      },
      buyer: {
        country: 'Austria',
        city: 'Vienna',
        zipCode: '1010',
        street: 'Buyer Gasse',
        streetNumber: '5',
        email: null,
        phone: null,
        name: null,
        companyName: 'Austrian Buyer GmbH',
        vatNumber: 'AT987654321',
      },
    };

    const pdfBuffer = await generateInvoicePDF(multiVatIncludedData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'multi-vat-included-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Multi VAT included example saved to: ${outputPath}`);
  });

  it('should handle custom decimals and currency settings', async () => {
    const customDecimalsCurrencyData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-custom-formatting',
      action: 'generate_invoice' as const,
      invoiceTitle: 'Custom Formatting Invoice',
      decimals: 3, // Global 3 decimal places
      currency: 'EUR', // Global EUR currency
      vatRate: 0.21, // 21% VAT
      vatIsIncludedInThePrice: false,
      invoiceItems: [
        {
          name: 'High Precision Product',
          quantity: 1,
          price: 123.456789, // Will show 3 decimals: 123.457 EUR
          currency: 'USD', // Will be overridden by currencyOverride
          currencyOverride: 'EUR',
        },
        {
          name: 'Zero Decimal Product',
          quantity: 2,
          price: 50.0, // Will show 0 decimals: 50 GBP each
          currency: 'USD',
          decimalsOverride: 0,
          currencyOverride: 'GBP',
        },
        {
          name: 'Four Decimal Service',
          quantity: 1,
          price: 99.12345, // Will show 4 decimals: 99.1235 CHF
          currency: 'USD',
          decimalsOverride: 4,
          currencyOverride: 'CHF',
        },
        {
          name: 'Default Format Item',
          quantity: 1,
          price: 75.5, // Will use global: 75.500 EUR
          currency: 'USD', // Will be overridden by global currency
        },
      ],
      seller: {
        country: 'Switzerland',
        city: 'Zurich',
        zipCode: '8001',
        street: 'Precision Street',
        streetNumber: '1',
        email: 'precision@test.com',
        phone: null,
        name: 'Precision Seller',
        companyName: 'Precision Formatting AG',
        vatNumber: 'CHE-123.456.789',
      },
      buyer: {
        country: 'Germany',
        city: 'Munich',
        zipCode: '80331',
        street: 'Buyer Str',
        streetNumber: '10',
        email: null,
        phone: null,
        name: null,
        companyName: 'Formatting Test GmbH',
        vatNumber: 'DE123456789',
      },
    };

    const pdfBuffer = await generateInvoicePDF(customDecimalsCurrencyData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'custom-formatting-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Custom formatting example saved to: ${outputPath}`);
  });

  it('should handle different thousand delimiters', async () => {
    const delimiterTestData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-delimiters',
      action: 'generate_invoice' as const,
      invoiceTitle: 'Delimiter Test Invoice',
      decimals: 2,
      currency: 'EUR',
      thousandDelimiter: ',' as const, // Comma thousand separator
      decimalDelimiter: '.' as const, // Period decimal separator
      vatRate: 0.19,
      vatIsIncludedInThePrice: false,
      invoiceItems: [
        {
          name: 'Large Amount Product',
          quantity: 1,
          price: 12345.67, // Will show as 12,345.67 EUR
          currency: 'EUR',
        },
        {
          name: 'Very Large Amount Service',
          quantity: 2,
          price: 1234567.89, // Will show as 1,234,567.89 EUR each
          currency: 'EUR',
        },
        {
          name: 'Thousand Test',
          quantity: 1,
          price: 1000.0, // Will show as 1,000.00 EUR
          currency: 'EUR',
        },
        {
          name: 'Small Amount',
          quantity: 5,
          price: 99.95, // Will show as 99.95 EUR (no delimiter needed)
          currency: 'EUR',
        },
      ],
      seller: {
        country: 'Germany',
        city: 'Berlin',
        zipCode: '10115',
        street: 'Delimiter Street',
        streetNumber: '1000',
        email: 'delimiter@test.com',
        phone: null,
        name: 'Delimiter Test Seller',
        companyName: 'Number Formatting GmbH',
        vatNumber: 'DE123456789',
      },
      buyer: {
        country: 'France',
        city: 'Paris',
        zipCode: '75001',
        street: 'Rue des Numbers',
        streetNumber: '1234',
        email: null,
        phone: null,
        name: null,
        companyName: 'French Buyer Company',
        vatNumber: 'FR123456789',
      },
    };

    const pdfBuffer = await generateInvoicePDF(delimiterTestData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'delimiter-test-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Delimiter test example saved to: ${outputPath}`);
  });

  it('should use Node.js default formatting when no delimiter specified', async () => {
    const defaultFormattingData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-default-formatting',
      action: 'generate_invoice' as const,
      invoiceTitle: 'Default Formatting Invoice',
      decimals: 2,
      currency: 'USD',
      // No delimiter specified - should use Node.js default
      vatRate: 0.08,
      vatIsIncludedInThePrice: false,
      invoiceItems: [
        {
          name: 'Default Formatted Product',
          quantity: 1,
          price: 12345.67, // Will use Node.js default formatting
          currency: 'USD',
        },
        {
          name: 'Million Dollar Service',
          quantity: 1,
          price: 1000000.99, // Will use Node.js default formatting
          currency: 'USD',
        },
      ],
      seller: {
        country: 'United States',
        city: 'New York',
        zipCode: '10001',
        street: 'Default Street',
        streetNumber: '123',
        email: 'default@test.com',
        phone: null,
        name: 'Default Formatting Seller',
        companyName: 'Default Format LLC',
        vatNumber: 'US123456789',
      },
      buyer: {
        country: 'Canada',
        city: 'Toronto',
        zipCode: 'M5V 3A8',
        street: 'Buyer Avenue',
        streetNumber: '456',
        email: null,
        phone: null,
        name: null,
        companyName: 'Canadian Buyer Inc',
        vatNumber: 'CA123456789',
      },
    };

    const pdfBuffer = await generateInvoicePDF(defaultFormattingData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'default-formatting-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Default formatting example saved to: ${outputPath}`);
  });

  it('should handle correction invoice with reference to original', async () => {
    const correctionInvoiceData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-correction-invoice',
      action: 'generate_invoice' as const,
      invoiceTitle: 'Invoice',
      invoiceDate: '2025-01-20',
      correctionInvoiceReference: {
        originalInvoiceNumber: 'INV-2025-001',
        originalInvoiceDate: '2025-01-15',
        correctionReason: 'Correcting VAT rate and updating item quantities',
      },
      decimals: 2,
      currency: 'EUR',
      vatRate: 0.21, // Corrected VAT rate
      vatIsIncludedInThePrice: false,
      invoiceItems: [
        {
          name: 'Corrected Product A',
          quantity: 3, // Corrected quantity (was 2)
          price: 150.0,
          currency: 'EUR',
        },
        {
          name: 'Additional Service',
          quantity: 1, // New item
          price: 75.0,
          currency: 'EUR',
        },
        {
          name: 'Refunded Item',
          quantity: 1,
          price: -50.0, // Negative amount for refund
          currency: 'EUR',
        },
      ],
      invoiceGreetings:
        'This correction invoice updates the original invoice with the correct information.',
      seller: {
        country: 'Netherlands',
        city: 'Amsterdam',
        zipCode: '1012 AB',
        street: 'Correction Street',
        streetNumber: '25',
        email: 'corrections@example.com',
        phone: '+31 20 1234567',
        name: 'Correction Seller',
        companyName: 'Invoice Corrections B.V.',
        vatNumber: 'NL123456789B01',
      },
      buyer: {
        country: 'Belgium',
        city: 'Brussels',
        zipCode: '1000',
        street: 'Buyer Boulevard',
        streetNumber: '100',
        email: 'buyer@example.be',
        phone: null,
        name: null,
        companyName: 'Correction Buyer N.V.',
        vatNumber: 'BE0123456789',
      },
    };

    const pdfBuffer = await generateInvoicePDF(correctionInvoiceData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'correction-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Correction invoice example saved to: ${outputPath}`);
  });

  it('should handle European number formatting (period thousands, comma decimals)', async () => {
    const europeanFormattingData = {
      signature: 'mock-signature',
      key: 'mock-key',
      walletAddress: 'addr1test',
      validUntil: Date.now() + 1000 * 60 * 60,
      blockchainIdentifier: 'test-european-formatting',
      action: 'generate_invoice' as const,
      invoiceTitle: 'European Formatting Invoice',
      decimals: 2,
      currency: 'EUR',
      thousandDelimiter: '.' as const, // Period thousand separator (1.000)
      decimalDelimiter: ',' as const, // Comma decimal separator (1.000,50)
      vatRate: 0.19,
      vatIsIncludedInThePrice: false,
      invoiceItems: [
        {
          name: 'European Format Product',
          quantity: 1,
          price: 12345.67, // Will show as 12.345,67 EUR
          currency: 'EUR',
        },
        {
          name: 'Large Amount Service',
          quantity: 1,
          price: 1234567.89, // Will show as 1.234.567,89 EUR
          currency: 'EUR',
        },
      ],
      seller: {
        country: 'Germany',
        city: 'Berlin',
        zipCode: '10115',
        street: 'European Street',
        streetNumber: '123',
        email: 'european@test.com',
        phone: null,
        name: 'European Seller',
        companyName: 'European Formatting GmbH',
        vatNumber: 'DE123456789',
      },
      buyer: {
        country: 'France',
        city: 'Paris',
        zipCode: '75001',
        street: 'Rue Européenne',
        streetNumber: '456',
        email: null,
        phone: null,
        name: null,
        companyName: 'French European SARL',
        vatNumber: 'FR123456789',
      },
    };

    const pdfBuffer = await generateInvoicePDF(europeanFormattingData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'european-formatting-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`European formatting example saved to: ${outputPath}`);
  });

  it('should generate PDF with German language localization', async () => {
    const germanInvoiceData = {
      ...mockInvoiceData,
      language: 'de' as const,
      invoiceDate: '2025-01-15',
      invoiceTitle: 'Agentenservice Rechnung',
      invoiceDescription: 'Zahlung für KI-Agenten-Services',
      invoiceGreetings:
        'Vielen Dank für die Nutzung unserer KI-Agenten-Services!',
      invoiceClosing: 'Wir schätzen Ihre prompte Zahlung.',
      invoiceSignature: 'MASUMI AI Team',
      invoiceTerms:
        'Die Zahlung ist innerhalb von 30 Tagen nach Rechnungsdatum fällig.',
      invoicePrivacy:
        'Ihre Privatsphäre ist uns wichtig. Wir werden Ihre Informationen nicht weitergeben.',
      vatRate: 0.19, // 19% MwSt.
      invoiceFooter:
        'Dies ist eine computergenerierte Rechnung für KI-Agenten-Services.',
      invoiceItems: [
        {
          name: 'KI-Agenten-Service Nutzung',
          quantity: 2,
          price: 75.5,
          currency: 'EUR',
        },
        {
          name: 'Premium Support',
          quantity: 1,
          price: 25.0,
          currency: 'EUR',
          vatRateOverride: 0.07, // 7% MwSt.
        },
      ],
      seller: {
        country: 'Deutschland',
        city: 'München',
        zipCode: '80331',
        street: 'KI-Straße',
        streetNumber: '42',
        email: 'rechnung@masumi.ai',
        phone: '+49 89 123456789',
        name: 'MASUMI AI Team',
        companyName: 'MASUMI AI Services GmbH',
        vatNumber: 'DE123456789',
      },
      buyer: {
        country: 'Österreich',
        city: 'Wien',
        zipCode: '1010',
        street: 'Wiener Straße',
        streetNumber: '123',
        email: 'kunde@beispiel.at',
        phone: '+43 1 1234567',
        name: 'Max Mustermann',
        companyName: 'Musterfirma GmbH',
        vatNumber: 'ATU12345678',
      },
    };

    const pdfBuffer = await generateInvoicePDF(germanInvoiceData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save German example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'german-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`German invoice example saved to: ${outputPath}`);
  });

  it('should generate PDF with UK English formatting', async () => {
    const ukInvoiceData = {
      ...mockInvoiceData,
      language: 'en-uk' as const,
      invoiceDate: '2025-01-15',
      invoiceItems: [
        {
          name: 'Consulting Services',
          quantity: 10,
          price: 150.75,
          currency: 'GBP',
        },
        {
          name: 'Project Management',
          quantity: 1,
          price: 2500.0,
          currency: 'GBP',
          vatRateOverride: 0.2, // 20% VAT
        },
      ],
      seller: {
        country: 'United Kingdom',
        city: 'London',
        zipCode: 'SW1A 1AA',
        street: 'Westminster',
        streetNumber: '10',
        email: 'billing@uk-company.co.uk',
        phone: '+44 20 7946 0958',
        name: 'UK Services Team',
        companyName: 'British Consulting Ltd',
        vatNumber: 'GB123456789',
      },
      buyer: {
        country: 'Ireland',
        city: 'Dublin',
        zipCode: 'D02 XY45',
        street: 'Grafton Street',
        streetNumber: '123',
        email: 'accounts@irish-company.ie',
        phone: '+353 1 234 5678',
        name: "Patrick O'Sullivan",
        companyName: 'Irish Tech Ltd',
        vatNumber: 'IE9876543AB',
      },
    };

    const pdfBuffer = await generateInvoicePDF(ukInvoiceData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save UK example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'uk-english-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`UK English invoice example saved to: ${outputPath}`);
  });

  it('should use custom date format when specified', async () => {
    const customDateFormatData = {
      ...mockInvoiceData,
      language: 'en-us' as const,
      dateFormat: 'YYYY-MM-DD',
      invoiceDate: '2025-01-15',
    };

    const pdfBuffer = await generateInvoicePDF(customDateFormatData);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(0);

    // Save custom date format example
    const outputDir = join(process.cwd(), 'test-output');
    const outputPath = join(outputDir, 'custom-date-format-invoice.pdf');
    writeFileSync(outputPath, pdfBuffer);
    console.log(`Custom date format example saved to: ${outputPath}`);
  });
});
