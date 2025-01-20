import type { PurchasesQuery } from '@/types/api'

interface Transaction {
  type: 'payment' | 'purchase'
  createdAt: string
  id: string
  amount: number
  status: string
  [key: string]: unknown
}

interface TransactionsResponse {
  status: string
  data: {
    transactions: Transaction[]
  }
}

const PAYMENT_API_BASE_URL = process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL

export async function fetchTransactions(
  token: string,
  params: PurchasesQuery
): Promise<TransactionsResponse> {
  if (!token) {
    throw new Error('Authorization token is required')
  }

  const {
    limit = 10,
    cursorIdentifier,
    network,
    sellingWalletVkey,
    paymentType,
    contractAddress
  } = params

  const commonParams = {
    limit: limit.toString(),
    ...(cursorIdentifier && { cursorIdentifier }),
    ...(network && { network: network.toString() }),
    ...(paymentType && { paymentType: paymentType.toString() }),
    ...(contractAddress && { contractAddress: contractAddress.toString() })
  }

  const purchaseParams = {
    ...commonParams,
    ...(sellingWalletVkey && { sellingWalletVkey: sellingWalletVkey.toString() })
  }

  try {
    const [paymentsRes, purchasesRes] = await Promise.all([
      fetch(`${PAYMENT_API_BASE_URL}/api/v1/payment?${new URLSearchParams(commonParams).toString()}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'token': token
        }
      }),
      fetch(`${PAYMENT_API_BASE_URL}/api/v1/purchase?${new URLSearchParams(purchaseParams).toString()}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'token': token
        }
      })
    ])

    if (!paymentsRes.ok || !purchasesRes.ok) {
      throw new Error('Failed to fetch transactions')
    }

    const [paymentsData, purchasesData] = await Promise.all([
      paymentsRes.json(),
      purchasesRes.json()
    ])

    const transactions = [
      ...(paymentsData.data?.payments || []).map((p: Transaction) => ({ ...p, type: 'payment' })),
      ...(purchasesData.data?.purchases || []).map((p: Transaction) => ({ ...p, type: 'purchase' }))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    return {
      status: 'success',
      data: { transactions }
    }
  } catch (error) {
    console.error('Transactions fetch failed:', error)
    throw error
  }
} 