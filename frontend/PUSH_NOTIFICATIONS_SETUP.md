# Push Notifications Setup

This application supports web push notifications for real-time updates. To enable push notifications, you need to generate and configure VAPID keys.

## What are VAPID Keys?

VAPID (Voluntary Application Server Identification) keys are cryptographic keys used to identify your application to push services. They consist of:
- A **public key** (used by the client/frontend)
- A **private key** (used by the server/backend)

## Setup Instructions

### 1. Generate VAPID Keys

You can generate VAPID keys using Node.js with the `web-push` library:

```bash
npm install -g web-push
web-push generate-vapid-keys
```

This will output something like:
```
Public Key: BL8kOqZp3Z...
Private Key: xYz9AbC123...
```

### 2. Frontend Configuration

Add the public key to your environment variables:

```env
NEXT_PUBLIC_VAPID_PUBLIC_KEY=BL8kOqZp3Z...
```

The public key will be used by the browser to subscribe to push notifications.

### 3. Backend Configuration

Store the private key securely in your backend environment. You'll need it when sending push notifications.

### 4. Testing

1. Navigate to Settings page
2. Click "Enable Notifications"
3. Grant permission when prompted
4. The subscription will be created and subscription data logged to console

## Next Steps

### Backend Integration

To complete the setup, you need to:

1. **Store Subscriptions**: When a user subscribes, send the subscription data to your backend:
   ```typescript
   // In settings.tsx, after successful subscription
   await apiClient.post('/push/subscribe', subscriptionData);
   ```

2. **Send Notifications**: Use the `web-push` library on your backend to send notifications:
   ```javascript
   const webpush = require('web-push');
   
   webpush.setVapidDetails(
     'mailto:your-email@example.com',
     process.env.VAPID_PUBLIC_KEY,
     process.env.VAPID_PRIVATE_KEY
   );
   
   await webpush.sendNotification(subscription, JSON.stringify({
     title: 'New Transaction',
     body: 'You have a new transaction',
     icon: '/logo.png',
     data: { url: '/transactions' }
   }));
   ```

## Security Notes

- Keep the private key secure and never expose it to the frontend
- The public key can be safely included in frontend code
- Use HTTPS in production (required for push notifications)
- Validate subscription endpoints before sending notifications

## Browser Support

Push notifications are supported in:
- Chrome/Edge (Windows, macOS, Android)
- Firefox (Windows, macOS, Android, Linux)
- Safari (macOS 16.4+, iOS 16.4+)

Note: Some browsers may require HTTPS or localhost for testing.

