import { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-toastify';

interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export function usePushNotifications() {
  const [isSupported, setIsSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    null,
  );
  const [subscription, setSubscription] = useState<PushSubscription | null>(
    null,
  );
  const [isSubscribing, setIsSubscribing] = useState(false);

  // Check if push notifications are supported
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      setIsSupported(true);
      setPermission(Notification.permission);
    }
  }, []);

  // Register service worker
  const registerServiceWorker =
    useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
      if (!('serviceWorker' in navigator)) {
        console.error('Service workers are not supported');
        return null;
      }

      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
        });
        console.log('Service Worker registered:', registration);
        return registration;
      } catch (error) {
        console.error('Service Worker registration failed:', error);
        toast.error('Failed to register service worker');
        return null;
      }
    }, []);

  // Request notification permission
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      toast.error('This browser does not support notifications');
      return false;
    }

    if (Notification.permission === 'granted') {
      setPermission('granted');
      return true;
    }

    if (Notification.permission === 'denied') {
      toast.error(
        'Notification permission was denied. Please enable it in your browser settings.',
      );
      setPermission('denied');
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission === 'granted') {
        return true;
      } else {
        toast.error('Notification permission was denied');
        return false;
      }
    } catch (error) {
      console.error('Error requesting notification permission:', error);
      toast.error('Failed to request notification permission');
      return false;
    }
  }, []);

  // Subscribe to push notifications
  const subscribe =
    useCallback(async (): Promise<PushSubscriptionData | null> => {
      if (!isSupported) {
        toast.error('Push notifications are not supported in this browser');
        return null;
      }

      setIsSubscribing(true);

      try {
        // Request permission first
        const hasPermission = await requestPermission();
        if (!hasPermission) {
          setIsSubscribing(false);
          return null;
        }

        // Register service worker
        const registration = await registerServiceWorker();
        if (!registration) {
          setIsSubscribing(false);
          return null;
        }

        // Check if VAPID key is configured
        const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
        if (!vapidPublicKey) {
          toast.error(
            'Push notifications are not configured. Please contact your administrator.',
          );
          setIsSubscribing(false);
          return null;
        }

        // Subscribe to push service
        const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
        const pushSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey as BufferSource,
        });

        setSubscription(pushSubscription);

        // Extract subscription data
        const subscriptionData: PushSubscriptionData = {
          endpoint: pushSubscription.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(
              pushSubscription.getKey('p256dh') || new ArrayBuffer(0),
            ),
            auth: arrayBufferToBase64(
              pushSubscription.getKey('auth') || new ArrayBuffer(0),
            ),
          },
        };

        toast.success('Successfully subscribed to push notifications');
        setIsSubscribing(false);
        return subscriptionData;
      } catch (error: unknown) {
        console.error('Error subscribing to push notifications:', error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to subscribe to push notifications';
        toast.error(errorMessage);
        setIsSubscribing(false);
        return null;
      }
    }, [isSupported, registerServiceWorker, requestPermission]);

  // Unsubscribe from push notifications
  const unsubscribe = useCallback(async (): Promise<boolean> => {
    if (!subscription) {
      return false;
    }

    try {
      const result = await subscription.unsubscribe();
      if (result) {
        setSubscription(null);
        toast.success('Unsubscribed from push notifications');
      }
      return result;
    } catch (error) {
      console.error('Error unsubscribing from push notifications:', error);
      toast.error('Failed to unsubscribe from push notifications');
      return false;
    }
  }, [subscription]);

  // Check existing subscription
  const checkSubscription = useCallback(async (): Promise<void> => {
    if (!isSupported) return;

    try {
      const registration = await navigator.serviceWorker.ready;
      const pushSubscription = await registration.pushManager.getSubscription();
      setSubscription(pushSubscription);
    } catch (error) {
      console.error('Error checking subscription:', error);
    }
  }, [isSupported]);

  // Initialize: check for existing subscription
  useEffect(() => {
    if (isSupported) {
      checkSubscription();
    }
  }, [isSupported, checkSubscription]);

  return {
    isSupported,
    permission,
    subscription,
    isSubscribing,
    subscribe,
    unsubscribe,
    requestPermission,
    registerServiceWorker,
  };
}

// Helper function to convert VAPID public key from base64 URL to Uint8Array
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Helper function to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
