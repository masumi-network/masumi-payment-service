import { Button } from "@/components/ui/button";
import Image from "next/image";
import logo from "@/assets/masumi_logo.png";
import Link from "next/link";
import { MessageSquare } from "lucide-react";

export function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b bg-background/80 backdrop-blur-md">
      <div className="max-w-[1400px] mx-auto w-full">
        <div className="h-14 px-4 flex items-center justify-between gap-4">
          <Image
            src={logo}
            alt="Masumi Logo"
            width={120}
            height={32}
            className="w-auto"
          />
          <Button
            variant="outline"
          >
            <Link href="https://www.masumi.network/contact" target="_blank" className="flex items-center gap-2">
              Support
              <MessageSquare className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
} 