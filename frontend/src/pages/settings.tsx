import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { useTheme } from '@/lib/contexts/ThemeContext';
import { AnimatedPage } from '@/components/ui/animated-page';
import { LuEye, LuEyeOff, LuSun, LuMoon, LuMonitor } from 'react-icons/lu';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import Head from 'next/head';
import { CopyButton } from '@/components/ui/copy-button';

export default function Settings() {
  const { apiKey, signOut } = useAppContext();
  const { preference, setThemePreference } = useTheme();
  const [showApiKey, setShowApiKey] = useState(false);

  const themeLabel = preference === 'light' ? 'Light' : preference === 'dark' ? 'Dark' : 'System';

  return (
    <MainLayout>
      <Head>
        <title>Settings | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Manage your account settings and preferences
            </p>
          </div>

          <div className="space-y-4">
            {/* Admin API Key */}
            <div
              className="border rounded-lg p-6 space-y-4 animate-fade-in-up opacity-0"
              style={{ animationDelay: '0ms' }}
            >
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
                    value={apiKey || ''}
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
                    <CopyButton value={apiKey || ''} />
                  </div>
                </div>
              </div>
            </div>

            {/* Theme Toggle */}
            <div
              className="border rounded-lg p-6 space-y-4 animate-fade-in-up opacity-0"
              id="settings-theme-toggle"
              style={{ animationDelay: '75ms' }}
            >
              <div>
                <h2 className="text-sm font-medium">Theme</h2>
                <p className="text-sm text-muted-foreground">Select your preferred theme</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative bg-[#F4F4F5] dark:bg-secondary rounded-full p-1 flex items-center w-[110px] h-8 gap-1">
                  <div
                    className={cn(
                      'absolute h-6 w-[32px] bg-white dark:bg-[#18181B] rounded-full shadow-xs transition-transform duration-200',
                      preference === 'light' && 'translate-x-0',
                      preference === 'auto' && 'translate-x-[35px]',
                      preference === 'dark' && 'translate-x-[70px]',
                    )}
                  />
                  <button
                    onClick={() => setThemePreference('light')}
                    className={cn(
                      'relative flex items-center justify-center h-6 w-[32px] rounded-full transition-colors z-10 active:scale-95',
                      preference === 'light' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    <LuSun className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setThemePreference('auto')}
                    className={cn(
                      'relative flex items-center justify-center h-6 w-[32px] rounded-full transition-colors z-10 active:scale-95',
                      preference === 'auto' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    <LuMonitor className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setThemePreference('dark')}
                    className={cn(
                      'relative flex items-center justify-center h-6 w-[32px] rounded-full transition-colors z-10 active:scale-95',
                      preference === 'dark' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    <LuMoon className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span className="text-sm text-muted-foreground">{themeLabel}</span>
              </div>
            </div>

            {/* Danger Zone */}
            <div
              className="border border-destructive/20 rounded-lg p-6 animate-fade-in-up opacity-0"
              style={{ animationDelay: '150ms' }}
            >
              <h2 className="text-sm font-medium">Danger Zone</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Sign out of the admin interface. You will need your API key to sign back in.
              </p>
              <Button
                variant="destructive"
                className="text-sm btn-hover-lift"
                onClick={() => {
                  signOut();
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
