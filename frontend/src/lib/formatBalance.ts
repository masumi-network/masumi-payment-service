const formatBalance = (balance: string): string => {
  if (!balance) return '';

  const cleanValue = balance.replace(/[^\d.]/g, '');

  const parts = cleanValue.split('.');
  const integerPart = parts[0];
  const decimalPart = parts[1];

  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return decimalPart ? `${formattedInteger}.${decimalPart}` : formattedInteger;
};

export default formatBalance;
