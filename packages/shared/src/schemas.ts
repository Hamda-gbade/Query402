import { z } from 'zod';

// Shared schemas for payment link validation
export const networkSchema = z.enum(['stellar', 'base', 'soroban']);
export const assetSchema = z.string().min(1);
export const destinationSchema = z.string().min(1);

export const paymentLinkSchema = z.object({
  amount: z.string().regex(/^[1-9]\d*$/),
  asset: assetSchema,
  destination: destinationSchema,
  network: networkSchema,
});

export type Network = z.infer<typeof networkSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export type PaymentLink = z.infer<typeof paymentLinkSchema>;
