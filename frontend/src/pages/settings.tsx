import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { useTheme } from '@/lib/contexts/ThemeContext';
import {
  LuEye,
  LuEyeOff,
  LuSun,
  LuMoon,
  LuMonitor,
  LuBell,
  LuBellOff,
} from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { CopyButton } from '@/components/ui/copy-button';
import { usePushNotifications } from '@/lib/hooks/usePushNotifications';
import { Spinner } from '@/components/ui/spinner';

export default function Settings() {
  const { state, signOut } = useAppContext();
  const { preference, setThemePreference } = useTheme();
  const [showApiKey, setShowApiKey] = useState(false);
  const {
    isSupported,
    permission,
    subscription,
    isSubscribing,
    subscribe,
    unsubscribe,
  } = usePushNotifications();

  const adminApiKey = state.apiKey || '';

  const handleSubscribe = async () => {
    const subscriptionData = await subscribe();
    if (subscriptionData) {
      // TODO: Send subscriptionData to backend to store
      console.log('Subscription data:', subscriptionData);
    }
  };

  const handleUnsubscribe = async () => {
    const success = await unsubscribe();
    if (success) {
      // TODO: Notify backend to remove subscription
      console.log('Unsubscribed successfully');
    }
  };

  return (
    <MainLayout>
      <Head>
        <title>Settings | Admin Interface</title>
      </Head>
      <div>
        <div className="mb-6">
          <h1 className="text-xl font-semibold mb-1">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your account settings and preferences
          </p>
        </div>

        <div className="space-y-6">
          {/* Admin API Key */}
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-medium">Admin API Key</h2>
              <p className="text-sm text-muted-foreground">
                Your admin API key for accessing the Masumi Node
              </p>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1 max-w-[400px]">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={adminApiKey}
                  readOnly
                  className="pr-20 font-mono text-sm"
                />
                <div className="absolute right-0 top-0 h-full flex items-center gap-1 pr-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? (
                      <LuEyeOff className="h-4 w-4" />
                    ) : (
                      <LuEye className="h-4 w-4" />
                    )}
                  </Button>
                  <CopyButton value={adminApiKey} />
                </div>
              </div>
            </div>
          </div>

          {/* Theme Toggle */}
          <div className="space-y-4" id="settings-theme-toggle">
            <div>
              <h2 className="text-sm font-medium">Theme</h2>
              <p className="text-sm text-muted-foreground">
                Select your preferred theme
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative bg-[#F4F4F5] dark:bg-secondary rounded-full p-1 flex items-center w-[110px] h-8 gap-1">
                <div
                  className={cn(
                    'absolute h-6 w-[32px] bg-white dark:bg-[#18181B] rounded-full shadow-sm transition-transform duration-200',
                    preference === 'light' && 'translate-x-0',
                    preference === 'auto' && 'translate-x-[35px]',
                    preference === 'dark' && 'translate-x-[70px]',
                  )}
                />
                <button
                  onClick={() => setThemePreference('light')}
                  className={cn(
                    'relative flex items-center justify-center h-6 w-[32px] rounded-full transition-colors z-10',
                    preference === 'light'
                      ? 'text-primary'
                      : 'text-muted-foreground',
                  )}
                >
                  <LuSun className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setThemePreference('auto')}
                  className={cn(
                    'relative flex items-center justify-center h-6 w-[32px] rounded-full transition-colors z-10',
                    preference === 'auto'
                      ? 'text-primary'
                      : 'text-muted-foreground',
                  )}
                >
                  <LuMonitor className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setThemePreference('dark')}
                  className={cn(
                    'relative flex items-center justify-center h-6 w-[32px] rounded-full transition-colors z-10',
                    preference === 'dark'
                      ? 'text-primary'
                      : 'text-muted-foreground',
                  )}
                >
                  <LuMoon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Push Notifications */}
          {isSupported && (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-medium">Push Notifications</h2>
                <p className="text-sm text-muted-foreground">
                  Receive browser notifications for important updates
                </p>
              </div>
              <div className="flex items-center gap-2">
                {subscription ? (
                  <>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LuBell className="h-4 w-4 text-green-500" />
                      <span>Notifications enabled</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleUnsubscribe}
                      disabled={isSubscribing}
                    >
                      {isSubscribing ? (
                        <Spinner size={16} />
                      ) : (
                        <>
                          <LuBellOff className="h-4 w-4 mr-2" />
                          Disable
                        </>
                      )}
                    </Button>
                  </>
                ) : permission === 'denied' ? (
                  <div className="text-sm text-destructive">
                    Notifications are blocked. Please enable them in your
                    browser settings.
                  </div>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleSubscribe}
                    disabled={isSubscribing}
                  >
                    {isSubscribing ? (
                      <Spinner size={16} />
                    ) : (
                      <>
                        <LuBell className="h-4 w-4 mr-2" />
                        Enable Notifications
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Sign Out */}
          <div className="pt-4 border-t w-full">
            <Button
              variant="destructive"
              className="text-sm"
              onClick={() => {
                signOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
