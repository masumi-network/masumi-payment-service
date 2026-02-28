import { useTheme } from '@/lib/contexts/ThemeContext';

export function Footer() {
  const { theme, setThemePreference } = useTheme();

  return (
    <footer className="fixed bottom-0 left-0 right-0 p-4 flex justify-center items-center bg-background/80 backdrop-blur-md border-t">
      <div className="max-w-[1400px] mx-auto w-full flex justify-between items-center">
        <div className="flex gap-4">
          <a
            href="https://www.masumi.network/about"
            target="_blank"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            About
          </a>
          <a
            href="https://www.house-of-communication.com/de/en/footer/privacy-policy.html"
            target="_blank"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Privacy Policy
          </a>
        </div>
        <div>
          <button
            onClick={() => setThemePreference(theme === 'dark' ? 'light' : 'dark')}
            className="text-sm text-muted-foreground hover:text-foreground p-2 rounded-full hover:bg-muted"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" />
                <path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" />
                <path d="m19.07 4.93-1.41 1.41" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </footer>
  );
}
