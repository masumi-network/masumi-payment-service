import 'dotenv/config'

export interface HealthCheckResponse {
  status: string;
  message?: string;
}

export async function checkHealth(): Promise<HealthCheckResponse> {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/health/`, {
      method: 'GET',
      headers: {
        'accept': 'application/json'
      }
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.message || 'Health check failed')
    }

    return data
  } catch (error) {
    console.error('Health check failed:', error)
    throw error
  }
}
