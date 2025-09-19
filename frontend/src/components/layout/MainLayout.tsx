import { Button } from '@/components/ui/button';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Bot,
  Wallet,
  FileText,
  FileInput,
  Key,
  Settings,
  Sun,
  Moon,
  MessageSquare,
  BookOpen,
  ChevronLeft,
  Bell,
  Search,
  NotebookPen,
} from 'lucide-react';
import { useTheme } from '@/lib/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { NotificationsDialog } from '@/components/notifications/NotificationsDialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useSearch, SearchableItem } from '@/lib/hooks/useSearch';
import { useAppContext } from '@/lib/contexts/AppContext';
import MasumiLogo from '@/components/MasumiLogo';
import { formatCount } from '@/lib/utils';
interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const router = useRouter();
  const { theme, setThemePreference, isChangingTheme } = useTheme();
  const { newTransactionsCount } = useTransactions();
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sidebarCollapsed');
      return saved ? JSON.parse(saved) : false;
    }
    return false;
  });
  const sideBarWidth = 280;
  const sideBarWidthCollapsed = 96;
  const [isMac, setIsMac] = useState(false);
  const { searchQuery, setSearchQuery, searchResults, handleSearch } =
    useSearch();
  const { state, dispatch } = useAppContext();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsMac(window.navigator.userAgent.includes('Macintosh'));
    }
  }, []);

  useEffect(() => {
    if (isChangingTheme) {
      const app = document.getElementById('__next');
      if (app) {
        app.style.transition = 'all 0.2s ease';
        app.style.filter = 'blur(10px)';
        app.style.pointerEvents = 'none';
        app.style.opacity = '1';
        app.style.scale = '1.1';
      }

      const timer = setTimeout(() => {
        if (app) {
          app.style.filter = '';
          app.style.pointerEvents = 'auto';
          app.style.opacity = '1';
          app.style.scale = '1';
        }
      }, 200);

      return () => {
        clearTimeout(timer);
        const app = document.getElementById('__next');
        if (app) {
          app.style.filter = '';
          app.style.transition = '';
          app.style.pointerEvents = 'auto';
          app.style.opacity = '1';
          app.style.scale = '1';
        }
      };
    }
  }, [isChangingTheme]);

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', JSON.stringify(collapsed));
  }, [collapsed]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const navItems = [
    { href: '/', name: 'Dashboard', icon: LayoutDashboard, badge: null },
    { href: '/ai-agents', name: 'AI Agents', icon: Bot, badge: null },
    { href: '/wallets', name: 'Wallets', icon: Wallet, badge: null },
    {
      href: '/transactions',
      name: 'Transactions',
      icon: FileText,
      badge: formatCount(newTransactionsCount),
    },
    {
      href: '/payment-sources',
      name: 'Payment sources',
      icon: FileInput,
      badge: null,
    },
    {
      href: '/input-schema-validator',
      name: 'Input Schema Validator',
      icon: NotebookPen,
      badge: null,
    },
    { href: '/api-keys', name: 'API keys', icon: Key, badge: null },
    { href: '/settings', name: 'Settings', icon: Settings, badge: null },
  ];

  const handleOpenNotifications = () => {
    setIsNotificationsOpen(true);
    // Don't mark as read immediately, let user view notifications first
  };

  const handleSearchSelect = (result: SearchableItem) => {
    setIsSearchOpen(false);
    router.push(result.href).then(() => {
      if (result.elementId) {
        setTimeout(() => {
          const element = document.getElementById(result.elementId || '');
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight-element');
            setTimeout(() => {
              element.classList.remove('highlight-element');
            }, 4000);
          }
        }, 100);
      }
    });
  };

  const handleCommandSelect = (value: string) => {
    const result = searchResults.find((r) => r.id === value);
    if (result) {
      handleSearchSelect(result);
    }
  };

  const handleNetworkChange = (network: 'Preprod' | 'Mainnet') => {
    dispatch({ type: 'SET_NETWORK', payload: network });
  };

  return (
    <div
      className="flex bg-background w-full"
      style={{
        overflowY: 'scroll',
        overflowX: 'hidden',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <aside
        className={cn(
          'fixed left-0 top-0 z-40 h-screen border-r transition-[width] duration-300',
          'bg-[#FAFAFA] dark:bg-background',
        )}
        data-collapsed={collapsed}
        style={{
          width: collapsed ? `${sideBarWidthCollapsed}px` : `${sideBarWidth}px`,
        }}
      >
        <div className="flex flex-col space-y-6">
          <div
            className={cn(
              'flex gap-2 border-b p-2.5 px-4 w-full',
              collapsed ? 'justify-center items-center' : '',
            )}
          >
            <div
              className={cn(
                'grid w-full p-1 bg-[#F4F4F5] dark:bg-secondary rounded-md',
                collapsed ? 'grid-cols-2 w-auto gap-0.5' : 'grid-cols-2 gap-2',
              )}
            >
              <Button
                variant="ghost"
                size="sm2"
                className={cn(
                  'flex-1 font-medium hover:bg-[#FFF0] hover:scale-[1.1] transition-all duration-300',
                  collapsed && 'px-2',
                  state.network === 'Preprod' &&
                    'bg-[#FFF] dark:bg-background hover:bg-[#FFF] dark:hover:bg-background',
                )}
                onClick={() => handleNetworkChange('Preprod')}
              >
                {collapsed ? 'P' : 'Preprod'}
              </Button>
              <Button
                variant="ghost"
                size="sm2"
                className={cn(
                  'flex-1 font-medium hover:bg-[#FFF0] hover:scale-[1.1] transition-all duration-300',
                  collapsed && 'px-2',
                  state.network === 'Mainnet' &&
                    'bg-[#FFF] dark:bg-background hover:bg-[#FFF] dark:hover:bg-background',
                )}
                onClick={() => handleNetworkChange('Mainnet')}
              >
                {collapsed ? 'M' : 'Mainnet'}
              </Button>
            </div>
          </div>

          <div
            className={cn(
              'flex items-center p-2 px-4',
              collapsed ? 'justify-center' : 'justify-between',
            )}
          >
            {!collapsed && (
              <Link href="/">
                <MasumiLogo />
              </Link>
            )}
            <Button
              variant={collapsed ? 'ghost' : 'muted'}
              size="icon"
              className="h-8 w-8"
              onClick={() => setCollapsed(!collapsed)}
            >
              <div
                className={cn(
                  'flex transition-transform duration-300',
                  collapsed && 'rotate-180',
                )}
              >
                <ChevronLeft className="h-4 w-4" />
                <ChevronLeft className="h-4 w-4 -ml-2" />
              </div>
            </Button>
          </div>
        </div>

        <nav
          className={cn(
            'flex flex-col gap-1 mt-4',
            collapsed ? 'px-0 items-center' : 'p-2',
          )}
        >
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center rounded-lg text-sm transition-all relative',
                'hover:bg-[#F4F4F5] dark:hover:bg-secondary',
                collapsed ? 'h-10 w-10 justify-center' : 'px-3 py-2 gap-3',
                router.pathname === item.href &&
                  'bg-[#F4F4F5] dark:bg-secondary font-bold',
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon className="h-4 w-4" />
              {!collapsed && <span>{item.name}</span>}
              {!collapsed && item.badge && (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-normal text-white">
                  {item.badge}
                </span>
              )}
              {collapsed && item.badge && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-normal text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div
          className={cn(
            'absolute bottom-4 left-0 right-0',
            collapsed ? 'px-2' : 'px-4',
          )}
        >
          <div className="flex items-center justify-between">
            <div
              className={cn(
                'flex gap-4 text-xs text-muted-foreground',
                collapsed && 'hidden',
              )}
            >
              <Link href="https://www.masumi.network/about" target="_blank">
                About
              </Link>
              <Link
                href="https://www.house-of-communication.com/de/en/footer/privacy-policy.html"
                target="_blank"
              >
                Privacy Policy
              </Link>
              <Link
                href="https://www.masumi.network/product-releases"
                target="_blank"
              >
                Changelog
              </Link>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-8 w-8', collapsed && 'mx-auto')}
              onClick={() =>
                setThemePreference(theme === 'dark' ? 'light' : 'dark')
              }
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </aside>

      <div
        className="flex flex-col min-h-screen w-[100vw] transition-all duration-300"
        style={{
          paddingLeft: collapsed
            ? `${sideBarWidthCollapsed}px`
            : `${sideBarWidth}px`,
        }}
      >
        <div className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="max-w-[1400px] mx-auto w-full">
            <div className="h-14 px-4 flex items-center justify-between gap-4">
              <div
                className="flex flex-1 max-w-[190px] justify-start gap-1 relative items-center rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background cursor-pointer items-center"
                onClick={() => setIsSearchOpen(true)}
              >
                <Search className="h-4 w-4 text-muted-foreground" />
                <div className="pl-2">{`Search... `}</div>
                <div className="pl-4">{`(${isMac ? '⌘' : 'Ctrl'} + K)`}</div>
              </div>

              <div className="flex items-center gap-4">
                <Button variant="outline" size="sm" asChild>
                  <Link
                    href="https://docs.masumi.network"
                    target="_blank"
                    className="flex items-center gap-2"
                  >
                    <BookOpen className="h-4 w-4" />
                    Documentation
                  </Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link
                    href="https://www.masumi.network/contact"
                    target="_blank"
                    className="flex items-center gap-2"
                  >
                    <MessageSquare className="h-4 w-4" />
                    Support
                  </Link>
                </Button>
                <Button
                  variant={newTransactionsCount ? 'default' : 'outline'}
                  size="sm"
                  className={cn(
                    'h-8 px-3 flex items-center gap-2',
                    newTransactionsCount
                      ? 'bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:text-white dark:hover:bg-red-600'
                      : '',
                  )}
                  onClick={handleOpenNotifications}
                >
                  <Bell className="h-4 w-4" />
                  {formatCount(newTransactionsCount)}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <main className="flex-1 relative z-10 w-full">
          <div className="max-w-[1400px] mx-auto w-full p-8 px-4">
            {children}
          </div>
        </main>
      </div>

      <Dialog open={isSearchOpen} onOpenChange={setIsSearchOpen}>
        <DialogContent>
          <Command className="py-2">
            <CommandInput
              placeholder="Type to search..."
              value={searchQuery}
              onValueChange={(value) => {
                setSearchQuery(value);
                handleSearch(value);
              }}
              className="p-1 px-2 mb-2"
            />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup>
                {searchResults.map((result) => (
                  <CommandItem
                    key={result.id}
                    onSelect={() => handleCommandSelect(result.id)}
                    onClick={() => handleCommandSelect(result.id)}
                    className="flex flex-col items-start p-2 cursor-pointer pointer-events-auto"
                    style={{ cursor: 'pointer', pointerEvents: 'all' }}
                  >
                    <div className="font-medium">{result.title || '...'}</div>
                    {result.description && (
                      <div className="text-sm text-muted-foreground">
                        {result.description}
                      </div>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {isNotificationsOpen && (
        <NotificationsDialog
          open={isNotificationsOpen}
          onClose={() => setIsNotificationsOpen(false)}
        />
      )}
    </div>
  );
}
