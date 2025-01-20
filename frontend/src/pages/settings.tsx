import BlinkingUnderscore from "@/components/BlinkingUnderscore";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useAppContext } from "@/lib/contexts/AppContext";
import { useRouter } from "next/router";
import { Eye, EyeOff } from "lucide-react";

export default function Settings() {
  const [showApiKey, setShowApiKey] = useState(false);
  const { state, dispatch } = useAppContext();
  const router = useRouter();

  const handleSignOut = () => {
    localStorage.removeItem("payment_api_key");
    dispatch({ type: 'SET_API_KEY', payload: "" });
    router.push('/');
  };

  const toggleApiKeyVisibility = () => {
    setShowApiKey(!showApiKey);
  };

  return (
    <MainLayout>
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-lg font-medium">API Key</h3>
            <div className="flex items-center space-x-2">
              <div className="font-mono bg-secondary px-4 py-2 rounded-md flex items-center">
                {state.apiKey ? (
                  showApiKey ? (
                    state.apiKey
                  ) : (
                    "••••••••••••••••••••••••••"
                  )
                ) : (
                  <BlinkingUnderscore />
                )}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={toggleApiKeyVisibility}
                title={showApiKey ? "Hide API Key" : "Show API Key"}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <Button
              variant="destructive"
              onClick={handleSignOut}
            >
              Sign Out
            </Button>
          </div>
        </CardContent>
      </Card>
    </MainLayout>
  );
} 