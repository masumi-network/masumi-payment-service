import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import Head from 'next/head';
import { Button } from '@/components/ui/button';
import { Home, Search } from 'lucide-react';
import Link from 'next/link';
import MasumiLogo from '@/components/MasumiLogo';

export default function NotFound() {
  return (
    <>
      <Head>
        <title>404 - Page Not Found | Masumi</title>
      </Head>
      <MainLayout>
        <div className="flex flex-col items-center justify-center min-h-[600px] px-4">
          <div className="text-center max-w-lg">
            <div className="mb-8 flex justify-center animate-pop-in">
              <MasumiLogo />
            </div>

            <h1
              className="text-6xl font-bold text-muted-foreground mb-4 animate-scale-in-bounce opacity-0"
              style={{ animationDelay: '100ms' }}
            >
              404
            </h1>
            <h2
              className="text-2xl font-semibold mb-4 animate-fade-in-up opacity-0"
              style={{ animationDelay: '200ms' }}
            >
              Page Not Found
            </h2>
            <p
              className="text-muted-foreground mb-8 animate-fade-in-up opacity-0"
              style={{ animationDelay: '300ms' }}
            >
              The page you are looking for does not exist or has been moved. Lets get you back on
              track.
            </p>

            <div
              className="flex flex-col sm:flex-row gap-3 justify-center animate-fade-in-up opacity-0"
              style={{ animationDelay: '400ms' }}
            >
              <Button asChild size="lg" className="gap-2">
                <Link href="/">
                  <Home className="h-4 w-4" />
                  Go to Dashboard
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="gap-2">
                <Link href="https://docs.masumi.network" target="_blank" rel="noopener noreferrer">
                  <Search className="h-4 w-4" />
                  Browse Documentation
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </MainLayout>
    </>
  );
}
