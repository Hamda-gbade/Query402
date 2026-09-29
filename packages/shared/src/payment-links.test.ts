import { buildPaymentLink } from './payment-links';

describe('buildPaymentLink', () => {
  const validInput = {
    amount: '100',
    asset: 'USDC',
    destination: 'GCTRCN2H6EVVRQH4MKHVWMTY2SPC4ZTRHQZQOSKF5PXFRA4TNDGGF4VL',
    network: 'stellar',
    secret: 'sensitive_data', // Should not appear in errors
  };

  it('produces a link for valid inputs', () => {
    const result = buildPaymentLink(validInput);
    expect(result.url).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('rejects zero amount', () => {
    const result = buildPaymentLink({ ...validInput, amount: '0' });
    expect(result.error).toBe('Invalid amount');
    expect(result.url).toBeUndefined();
  });

  it('rejects non-integer amount', () => {
    const result = buildPaymentLink({ ...validInput, amount: '100.5' });
    expect(result.error).toBe('Invalid amount');
    expect(result.url).toBeUndefined();
  });

  it('rejects missing destination', () => {
    const result = buildPaymentLink({ ...validInput, destination: '' });
    expect(result.error).toBe('Invalid parameters');
    expect(result.url).toBeUndefined();
  });

  it('does not expose secrets in errors', () => {
    const result = buildPaymentLink({ ...validInput, amount: '0' });
    expect(result.error).not.toContain('sensitive_data');
  });

  it('rejects invalid network', () => {
    const result = buildPaymentLink({ ...validInput, network: 'invalid' });
    expect(result.error).toBe('Invalid parameters');
  });
});
