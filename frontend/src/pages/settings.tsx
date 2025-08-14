import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { useTheme } from '@/lib/contexts/ThemeContext';
import { LuEye, LuEyeOff, LuSun, LuMoon, LuMonitor } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/router';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { CopyButton } from '@/components/ui/copy-button';
import { getApiKeyStatus } from '@/lib/api/generated';

export default function Settings() {
  const router = useRouter();
  const { dispatch, state, apiClient } = useAppContext();
  const { preference, setThemePreference } = useTheme();
  const [showApiKey, setShowApiKey] = useState(false);
  const [currentUserPermission, setCurrentUserPermission] = useState<
    'Read' | 'ReadAndPay' | 'Admin' | null
  >(null);

  const adminApiKey = state.apiKey || '';

  // Fetch current user's permission
  useEffect(() => {
    const fetchUserPermission = async () => {
      if (state.apiKey) {
        try {
          const response = await getApiKeyStatus({ client: apiClient });
          if (response.data?.data?.permission) {
            setCurrentUserPermission(response.data.data.permission);
          }
        } catch (error) {
          console.error('Failed to fetch user permission:', error);
        }
      }
    };
    fetchUserPermission();
  }, [state.apiKey, apiClient]);

  const getPermissionDisplayText = (
    _permission: 'Read' | 'ReadAndPay' | 'Admin' | null,
  ) => {
    return 'API Key';
  };

  const getPermissionDescription = (
    permission: 'Read' | 'ReadAndPay' | 'Admin' | null,
  ) => {
    switch (permission) {
      case 'Read':
        return 'Your read-only API key for accessing the Masumi Node';
      case 'ReadAndPay':
        return 'Your read and payment API key for accessing the Masumi Node';
      case 'Admin':
        return 'Your admin API key for accessing the Masumi Node';
      default:
        return 'Your API key for accessing the Masumi Node';
    }
  };

  const signOut = () => {
    localStorage.removeItem('payment_api_key');

    dispatch({ type: 'SET_API_KEY', payload: '' });

    router.push('/');
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
          {/* API Key */}
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-medium">
                {getPermissionDisplayText(currentUserPermission)}
              </h2>
              <p className="text-sm text-muted-foreground">
                {getPermissionDescription(currentUserPermission)}
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
