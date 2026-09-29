import { z } from 'zod';
import { paymentLinkSchema, networkSchema, assetSchema, destinationSchema } from './schemas';

export type PaymentLinkInput = {
  amount: string;
  asset: string;
  destination: string;
  network: string;
  secret?: string;
};

export type PaymentLinkOutput = {
  url: string;
  error?: never;
} | {
  url?: never;
  error: string;
};

/**
 * Generates a payment link only if inputs validate against the shared schema.
 * Rejects zero amounts, non-integer amounts, and missing destinations.
 * Never includes secrets in errors.
 */
export function buildPaymentLink(input: PaymentLinkInput): PaymentLinkOutput {
  // Validate amount: must be a non-zero integer (as string to avoid floating point)
  const amountValidation = z
    .string()
    .regex(/^[1-9]\d*$/, 'Amount must be a positive integer')
    .safeParse(input.amount);

  if (!amountValidation.success) {
    return { error: 'Invalid amount' };
  }

  // Validate network, asset, and destination against shared schemas
  const networkValidation = networkSchema.safeParse(input.network);
  const assetValidation = assetSchema.safeParse(input.asset);
  const destinationValidation = destinationSchema.safeParse(input.destination);

  if (!networkValidation.success || !assetValidation.success || !destinationValidation.success) {
    return { error: 'Invalid parameters' };
  }

  // Construct and validate the full payment link payload
  const linkPayload = {
    amount: amountValidation.data,
    asset: assetValidation.data,
    destination: destinationValidation.data,
    network: networkValidation.data,
  };

  const validation = paymentLinkSchema.safeParse(linkPayload);
  if (!validation.success) {
    return { error: 'Payment link validation failed' };
  }

  // Construct the URL (example format - adjust to actual implementation)
  const url = `https://pay.example.com/?amount=${linkPayload.amount}&asset=${linkPayload.asset}&destination=${linkPayload.destination}&network=${linkPayload.network}`;

  return { url };
}
