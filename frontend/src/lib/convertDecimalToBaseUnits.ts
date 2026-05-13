export function convertDecimalToBaseUnits(value: string, decimals: number = 6): string {
  const [wholePart, fractionalPart = ''] = value.split('.');
  const normalizedFractionalPart = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  const scale = BigInt(10) ** BigInt(decimals);

  return (BigInt(wholePart || '0') * scale + BigInt(normalizedFractionalPart || '0')).toString();
}
