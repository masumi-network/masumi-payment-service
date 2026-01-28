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
  PanelLeft,
  Bell,
  Search,
  NotebookPen,
  Code,
} from 'lucide-react';
import { useTheme } from '@/lib/contexts/ThemeContext';
import { useSidebar } from '@/lib/contexts/SidebarContext';
import { cn, normalizePathname } from '@/lib/utils';
import { useTransactions } from '@/lib/hooks/useTransactions';
import { NotificationsDialog } from '@/components/notifications/NotificationsDialog';
import { SearchDialog } from '@/components/search/SearchDialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import MasumiLogo from '@/components/MasumiLogo';
import { formatCount } from '@/lib/utils';
import MasumiIconFlat from '@/components/MasumiIconFlat';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { PaymentSourceExtended } from '@/lib/api/generated';
interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const router = useRouter();
  const { theme, setThemePreference, isChangingTheme } = useTheme();
  const { newTransactionsCount } = useTransactions();
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const { collapsed, setCollapsed, isHovered, setIsHovered, shouldAnimateIcon } = useSidebar();
  const sideBarWidth = 280;
  const sideBarWidthCollapsed = 96;
  const [isMac, setIsMac] = useState(false);
  const { network, setNetwork, isChangingNetwork } = useAppContext();

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
    if (isChangingNetwork) {
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
  }, [isChangingNetwork]);

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
  const { paymentSources } = usePaymentSourceExtendedAll();
  const [currentNetworkPaymentSources, setCurrentNetworkPaymentSources] = useState<
    PaymentSourceExtended[]
  >([]);
  useEffect(() => {
    setCurrentNetworkPaymentSources(paymentSources.filter((ps) => ps.network === network));
  }, [paymentSources, network]);

  const [hasPaymentSources, setHasPaymentSources] = useState(false);
  useEffect(() => {
    setHasPaymentSources(currentNetworkPaymentSources && currentNetworkPaymentSources.length > 0);
  }, [currentNetworkPaymentSources]);
  const [navItems, setNavItems] = useState<
    {
      href: string;
      name: string;
      icon: React.ReactNode;
      badge: React.ReactNode | null;
    }[]
  >([]);

  useEffect(() => {
    if (hasPaymentSources) {
      setNavItems([
        {
          href: '/',
          name: 'Dashboard',
          icon: <LayoutDashboard className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/ai-agents',
          name: 'AI Agents',
          icon: <Bot className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/wallets',
          name: 'Wallets',
          icon: <Wallet className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/transactions',
          name: 'Transactions',
          icon: <FileText className="h-4 w-4" />,
          badge: formatCount(newTransactionsCount),
        },
        {
          href: '/payment-sources',
          name: 'Payment sources',
          icon: <FileInput className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/input-schema-validator',
          name: 'Input Schema Validator',
          icon: <NotebookPen className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/openapi',
          name: 'OpenAPI',
          icon: <Code className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/api-keys',
          name: 'API keys',
          icon: <Key className="h-4 w-4" />,
          badge: null,
        },
        {
          href: '/settings',
          name: 'Settings',
          icon: <Settings className="h-4 w-4" />,
          badge: null,
        },
      ]);
      return;
    }
    setNavItems([
      {
        href: '/payment-sources',
        name: 'Payment sources',
        icon: <FileInput className="h-4 w-4" />,
        badge: null,
      },
      {
        href: '/settings',
        name: 'Settings',
        icon: <Settings className="h-4 w-4" />,
        badge: null,
      },
    ]);
  }, [hasPaymentSources, newTransactionsCount]);

  const handleOpenNotifications = () => {
    setIsNotificationsOpen(true);
  };

  const handleNetworkChange = (network: 'Preprod' | 'Mainnet') => {
    setNetwork(network);
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
          'bg-[#FAFAFA] dark:bg-[#111]',
        )}
        data-collapsed={collapsed}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{
          width: collapsed && !isHovered ? `${sideBarWidthCollapsed}px` : `${sideBarWidth}px`,
          pointerEvents: 'auto',
        }}
      >
        <div className="flex flex-col">
          <div
            className={cn(
              'flex gap-2 border-b p-2.5 px-4 w-full',
              collapsed && !isHovered ? 'justify-center items-center' : '',
            )}
          >
            <div
              className={cn(
                'grid w-full p-1 bg-[#F4F4F5] dark:bg-secondary rounded-md',
                collapsed && !isHovered ? 'grid-cols-2 w-auto gap-0.5' : 'grid-cols-2 gap-2',
              )}
            >
              <Button
                variant="ghost"
                size="sm2"
                className={cn(
                  'flex-1 font-medium hover:bg-[#FFF0] hover:scale-[1.1] transition-all duration-300 truncate',
                  collapsed && !isHovered && 'px-2',
                  network === 'Preprod' &&
                    'bg-[#FFF] dark:bg-background hover:bg-[#FFF] dark:hover:bg-background',
                )}
                onClick={() => handleNetworkChange('Preprod')}
              >
                {collapsed && !isHovered ? 'P' : 'Preprod'}
              </Button>
              <Button
                variant="ghost"
                size="sm2"
                className={cn(
                  'flex-1 font-medium hover:bg-[#FFF0] hover:scale-[1.1] transition-all duration-300 truncate',
                  collapsed && !isHovered && 'px-2',
                  network === 'Mainnet' &&
                    'bg-[#FFF] dark:bg-background hover:bg-[#FFF] dark:hover:bg-background',
                )}
                onClick={() => handleNetworkChange('Mainnet')}
              >
                {collapsed && !isHovered ? 'M' : 'Mainnet'}
              </Button>
            </div>
          </div>

          <div
            className={cn(
              'flex items-center p-2 px-4 border-b border-border',
              collapsed && !isHovered ? 'justify-center' : 'justify-between',
            )}
          >
            {!(collapsed && !isHovered) ? (
              <Link href="/" key="masumi-logo-full">
                <MasumiLogo />
              </Link>
            ) : (
              <Link
                href="/"
                key="masumi-logo-icon"
                className="flex items-center justify-center w-8 h-8"
                style={
                  shouldAnimateIcon && collapsed && !isHovered
                    ? {
                        animation: 'rotateIn 0.3s ease-out',
                      }
                    : undefined
                }
              >
                <MasumiIconFlat className="w-6 h-6" />
              </Link>
            )}
            {!(collapsed && !isHovered) && (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-8 w-8',
                  collapsed ? 'text-muted-foreground opacity-50' : 'text-foreground opacity-100',
                )}
                onClick={() => setCollapsed(!collapsed)}
              >
                <PanelLeft className={cn('h-4 w-4 transition-transform duration-300')} />
              </Button>
            )}
          </div>
        </div>

        <nav
          className={cn(
            'flex flex-col gap-1 mt-2 p-2',
            collapsed && !isHovered ? 'px-0 items-center' : 'px-2',
          )}
        >
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center rounded-lg text-sm transition-all relative',
                'hover:bg-[#F4F4F5] dark:hover:bg-secondary',
                collapsed && !isHovered ? 'h-10 w-10 justify-center' : 'px-3 h-10 gap-3',
                normalizePathname(router.pathname) === item.href &&
                  'bg-[#F4F4F5] dark:bg-secondary font-bold',
              )}
              title={collapsed && !isHovered ? item.name : undefined}
            >
              {item.icon}
              {!(collapsed && !isHovered) && <span className="truncate">{item.name}</span>}
              {!(collapsed && !isHovered) && item.badge && (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-normal text-white">
                  {item.badge}
                </span>
              )}
              {collapsed && !isHovered && item.badge && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-normal text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div
          className={cn(
            'absolute bottom-4 left-0 right-0 overflow-hidden transition-all duration-300',
            collapsed && !isHovered ? 'px-2' : 'px-4',
          )}
        >
          <div className="flex items-center justify-between">
            <div
              className={cn(
                'flex gap-4 text-xs text-muted-foreground',
                collapsed && !isHovered && 'hidden',
              )}
            >
              <Link href="https://www.masumi.network/about" target="_blank" className="truncate">
                About
              </Link>
              <Link
                href="https://www.house-of-communication.com/de/en/footer/privacy-policy.html"
                target="_blank"
                className="truncate"
              >
                Privacy Policy
              </Link>
              <Link
                href="https://www.masumi.network/product-releases"
                target="_blank"
                className="truncate"
              >
                Changelog
              </Link>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-8 w-8', collapsed && !isHovered && 'mx-auto')}
              onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </aside>

      <div
        className="flex flex-col min-h-screen w-screen transition-all duration-300"
        style={{
          paddingLeft: collapsed && !isHovered ? `${sideBarWidthCollapsed}px` : `${sideBarWidth}px`,
        }}
      >
        <div className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="max-w-[1400px] mx-auto w-full">
            <div className="h-14 px-4 flex items-center justify-between gap-4">
              <div
                className="flex flex-1 max-w-[190px] justify-start gap-1 relative rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background cursor-pointer items-center"
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
          <div className="max-w-[1400px] mx-auto w-full p-8 px-4">{children}</div>
        </main>
      </div>

      <SearchDialog open={isSearchOpen} onOpenChange={setIsSearchOpen} />

      {isNotificationsOpen && (
        <NotificationsDialog
          open={isNotificationsOpen}
          onClose={() => setIsNotificationsOpen(false)}
        />
      )}
    </div>
  );
}
