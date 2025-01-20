export async function deletePaymentSource(id: string, token: string) {
  if (!id) {
    throw new Error('Contract ID is required')
  }

  if (!token) {
    throw new Error('Authorization token is required')
  }

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/payment-source/?id=${id}`,
    {
      method: 'DELETE',
      headers: {
        'accept': 'application/json',
        'token': token
      }
    }
  )

  const data = await response.json()

  if (!response.ok) {
    console.error('Delete payment source failed:', data)
    throw new Error(data.message || 'Failed to delete payment source')
  }

  return data
}
