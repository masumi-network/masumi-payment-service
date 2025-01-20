import { Button } from "@/components/ui/button";
import { useRouter } from "next/router";
import Link from "next/link";
import Image from "next/image";
import { useState, useEffect } from "react";
import { IoHomeOutline, IoSettingsOutline, IoChevronDownOutline, IoChevronUpOutline } from "react-icons/io5";
import { RiRobot2Line } from "react-icons/ri";
import { TbLayoutSidebarLeftCollapse, TbLayoutSidebarLeftExpand } from "react-icons/tb";
import logo from "@/assets/long-logo.png";
import { cn } from "@/lib/utils";
import Head from "next/head";
import { LuFileText } from "react-icons/lu";
import { useAppContext } from "@/lib/contexts/AppContext";
import { ToastContainer } from "react-toastify";

interface MainLayoutProps {
  children: React.ReactNode;
}


export function MainLayout({ children }: MainLayoutProps) {
  const router = useRouter();
  const { state } = useAppContext();
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('sidebarCollapsed');
      return stored ? JSON.parse(stored) : false;
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem('sidebarCollapsed', JSON.stringify(isCollapsed));
  }, [isCollapsed]);

  const isActive = (path: string) => router.pathname === path;

  const getPageTitle = () => {
    const path = router.pathname;
    const contractName = router.query.name as string;

    if (path === '/') return 'Overview';
    if (path === '/settings') return 'Settings';
    if (path === '/wallets') return 'Wallets';
    if (path === '/contract/[name]') return `Contract ID: ${contractName}`;
    if (path.includes('/wallet/')) return 'Wallet Details';

    return 'Overview';
  };

  const pageTitle = `${getPageTitle()} | NMKR Admin`;

  const [isContractsOpen, setIsContractsOpen] = useState(false);

  const isContractActive = (contractId: string) => {
    return router.pathname === `/contract/${contractId}`;
  };

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
      </Head>
      <div className="flex min-h-screen bg-background">
        <aside
          className="fixed left-0 top-0 h-screen bg-card border-r border-border transition-all duration-300 ease-in-out z-30"
          style={{ width: isCollapsed ? "100px" : "300px" }}
        >
          <div className="p-4">
            <div className="mb-8 flex justify-between items-center gap-1">
              <Link
                href="https://masumi.network"
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer"
              >
                {isCollapsed ? (
                  <Image
                    src="/logo.ico"
                    alt="NMKR Icon"
                    width={40}
                    height={40}
                    className="rounded-[10px]"
                    priority
                  />
                ) : (
                  <Image
                    src={logo}
                    alt="NMKR Logo"
                    width={150}
                    height={40}
                    priority
                  />
                )}
              </Link>
              <Button
                variant={isCollapsed ? "ghost" : "outline"}
                size="icon"
                onClick={() => setIsCollapsed(!isCollapsed)}
                className="hover:bg-muted aspect-square min-w-[24px] h-auto"
              >
                {isCollapsed ? (
                  <TbLayoutSidebarLeftExpand className="h-4 w-4" />
                ) : (
                  <TbLayoutSidebarLeftCollapse className="h-4 w-4" />
                )}
              </Button>
            </div>
            <nav className="space-y-2 flex flex-col gap-2 items-center justify-center">
              <Button
                asChild
                variant={isActive("/") ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start",
                  isCollapsed && "w-9 h-9 justify-center ml-[0px]"
                )}
              >
                <Link href="/" className="flex items-center gap-2">
                  <IoHomeOutline className="h-4 w-4" />
                  {!isCollapsed && <span>Overview</span>}
                </Link>
              </Button>
              <div className="w-full flex flex-col gap-1 items-center">
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-between group",
                    isCollapsed && "w-9 h-9 justify-center"
                  )}
                  onClick={() => !isCollapsed && setIsContractsOpen(!isContractsOpen)}
                >
                  <div className="flex items-center gap-2">
                    <LuFileText className="h-4 w-4" />
                    {!isCollapsed && <span>Contracts</span>}
                  </div>
                  {(!isCollapsed) && (
                    <div className="opacity-50 group-hover:opacity-100">
                      {isContractsOpen ? (
                        <IoChevronUpOutline className="h-4 w-4" />
                      ) : (
                        <IoChevronDownOutline className="h-4 w-4" />
                      )}
                    </div>
                  )}
                </Button>

                {(isContractsOpen && !isCollapsed) && (
                  <div className={cn(
                    "flex flex-col gap-1 mt-1 items-center w-full",
                    !isCollapsed && "ml-4"
                  )}>
                    {state.paymentSources?.length > 0 ? <>
                      {state.paymentSources?.map((contract, index) => (
                        <Button
                          key={contract.id}
                          asChild
                          variant={isContractActive(contract.id) ? "secondary" : "ghost"}
                          className={cn(
                            "w-full justify-start hover:bg-[#fff1]",
                            isCollapsed && "w-9 h-9 justify-center ml-0"
                          )}
                        >
                          <Link
                            href={`/contract/${contract.name || contract.id}`}
                            className="flex items-center gap-2"
                          >
                            <div
                              className={cn(
                                "min-w-[16px] h-4 flex items-center justify-center text-xs rounded",
                                isContractActive(contract.id)
                                  ? "bg-[#fff] text-[#000]"
                                  : "bg-[#fff2]"
                              )}
                            >
                              {index + 1}
                            </div>
                            {!isCollapsed && (
                              <span className="truncate">
                                {contract.name || contract.paymentContractAddress?.slice(0, 8) + '...' + contract.paymentContractAddress?.slice(-4) || `Contract ${contract.id.slice(0, 8)}...`}
                              </span>
                            )}
                          </Link>
                        </Button>
                      ))}
                    </> : <div className="text-sm text-muted-foreground">No contracts found.</div>}
                  </div>
                )}
              </div>
              <Button
                asChild
                variant={isActive("/settings") ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start",
                  isCollapsed && "w-9 h-9 justify-center ml-[0px]"
                )}
              >
                <Link href="/settings" className="flex items-center gap-2">
                  <IoSettingsOutline className="h-4 w-4" />
                  {!isCollapsed && <span>Settings</span>}
                </Link>
              </Button>
            </nav>
          </div>
        </aside>

        <div
          className="flex flex-col min-h-screen transition-all duration-300 ease-in-out w-full"
          style={{ marginLeft: isCollapsed ? "100px" : "300px" }}
        >
          <header
            className="fixed top-0 right-0 h-16 border-b border-border backdrop-blur-[10px] bg-[#0008] z-20 transition-all duration-300 ease-in-out"
            style={{ width: `calc(100% - ${isCollapsed ? "100px" : "300px"})` }}
          >
            <div className="flex justify-between items-center h-full px-8">
              <h1 className="text-2xl font-semibold">
                {getPageTitle()}
              </h1>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 bg-[#fff1] px-4 py-1.5 rounded-md border border-border">
                  <RiRobot2Line className="h-4 w-4 text-[#ff0050]" />
                  <span className="text-sm text-muted-foreground">
                    Admin Interface
                  </span>
                </div>
              </div>
            </div>
          </header>

          <main className="flex-1 p-8 mt-16 relative z-10 w-full">
            {children}
          </main>
        </div>
      </div>
      <ToastContainer
        position="top-right"
        autoClose={3000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="dark"
      />
    </>
  );
} 