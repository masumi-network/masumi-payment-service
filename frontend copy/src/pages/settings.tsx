import BlinkingUnderscore from "@/components/BlinkingUnderscore";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { useAppContext } from "@/lib/contexts/AppContext";
import { useRouter } from "next/router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "react-toastify";
import { Pagination } from "@/components/ui/pagination";
import { ApiKeyGenerateModal } from "@/components/ApiKeyGenerateModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

type ApiKey = {
  apiKey: string;
  permission: "ADMIN" | "USER";
  usageLimited: boolean;
  RemainingUsageCredits?: {
    unit: string;
    amount: number;
  }[];
  status: "ACTIVE" | "INACTIVE";
};

export default function Settings() {
  const [showApiKey, setShowApiKey] = useState(false);
  const { state, dispatch } = useAppContext();
  const router = useRouter();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState<string | any>(null);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null);

  const fetchApiKeys = async (cursorId?: string) => {
    setIsLoading(true);
    console.log("fetching api keys", cursorId || "no cursor");
    try {
      const queryParams = new URLSearchParams({
        limit: '10',
        ...(cursorId && { cursorApiKey: cursorId })
      }).toString();

      const response = await fetch(`/api/api-keys?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${state.apiKey}`
        }
      });

      if (!response.ok) throw new Error('Failed to fetch API keys');
      
      const data = await response.json();
      const newKeys = data.keys || [];

      console.log("response", data);
      
      setApiKeys(prevKeys => {
        if (cursorId) {
          const existingIds = new Set(prevKeys.map((key:any) => key.apiKey));
          const uniqueNewKeys = newKeys.filter((key:any) => !existingIds.has(key.apiKey));
          return [...prevKeys, ...uniqueNewKeys];
        }
        return newKeys;
      });
      
      setHasMore(newKeys.length === 10);
      setCursor(newKeys[newKeys.length - 1]?.apiKey || null);
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
      toast.error('Failed to fetch API keys');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const handleKeyClick = (keyDetails: { 
    name: string; 
    value: string; 
    status: string; 
    createdAt: string;
  }) => {
    console.log(keyDetails);
  };

  const handleSignOut = () => {
    localStorage.removeItem("payment_api_key");
    dispatch({ type: 'SET_API_KEY', payload: "" });
    router.push('/');
  };

  const shortenString = (str: string, maxLength: number) => {
    return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
  };

  const toggleApiKeyVisibility = () => {
    setShowApiKey(!showApiKey);
  };

  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const handleGenerateClick = () => {
    setShowGenerateModal(true);
  };

  const handleDeleteApiKey = async (apiKey: string) => {
    try {
      const response = await fetch('/api/api-keys/delete', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.apiKey}`
        },
        body: JSON.stringify({ apiKey })
      });

      if (!response.ok) throw new Error('Failed to delete API key');
      
      await fetchApiKeys();
      toast.success('API key deleted successfully');
    } catch (error) {
      console.error('Failed to delete API key:', error);
      toast.error('Failed to delete API key');
    }
  };

  const handleUpdateClick = (key: ApiKey) => {
    setSelectedKey(key);
    setShowUpdateModal(true);
  };

  const handleDeleteClick = (key: ApiKey) => {
    setSelectedKey(key);
    setShowDeleteModal(true);
  };

  const handleConfirmDelete = async () => {
    if (!selectedKey) return;
    
    try {
      await handleDeleteApiKey(selectedKey.apiKey);
      setShowDeleteModal(false);
      setSelectedKey(null);
    } catch (error) {
      console.error('Failed to delete API key:', error);
    }
  };

  return (
    <MainLayout>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-lg font-medium">Admin API Key</h3>
            <div className="flex items-center space-x-2">
              <div className="font-mono bg-secondary px-4 py-2 rounded-md flex items-center">
                {state.apiKey ? (
                  showApiKey ? (
                    state.apiKey
                  ) : (
                    "•"?.repeat(state.apiKey.length)
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
        <Card>
          <CardHeader className="flex justify-between w-full flex-row items-center py-4 border-b border-[#fff2]">
            <CardTitle>Manage API Keys</CardTitle>
            <Button className="w-fit m-0" style={{ margin: "0px" }} onClick={handleGenerateClick}>
              Generate New API Key →
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="overflow-auto max-h-[600px]">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="text-left py-2">Key Name</th>
                      <th className="text-left py-2">Value (hover to expose)</th>
                      <th className="text-left py-2">Status</th>
                      <th className="text-left py-2">Usage Credits</th>
                      {/* <th className="text-right py-2">Actions</th> */}
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map((key:any) => (
                      <tr
                        key={key.apiKey}
                        className="hover:bg-secondary cursor-pointer"
                        onClick={() => handleKeyClick(key)}
                      >
                        <td className="py-2">{key.permission}</td>
                        <td 
                          className="py-2 font-mono"
                          onMouseEnter={() => setHoveredKey(key.apiKey)}
                          onMouseLeave={() => setHoveredKey(null)}
                        >
                          {hoveredKey === key.apiKey ? key.apiKey : "•".repeat(32)}
                        </td>
                        <td className="py-2">
                          <span className={`px-2 py-1 rounded-full text-sm ${
                            key.status === "ACTIVE" 
                              ? "bg-green-100 text-green-800" 
                              : "bg-red-300 text-red-800"
                          }`}>
                            {key.status}
                          </span>
                        </td>
                        <td className="py-2">
                          {key.usageLimited ? key.RemainingUsageCredits?.map((credit:any, i:any) => (
                            <div key={i} className="text-sm text-muted-foreground">
                              {credit.amount} {credit.unit}
                            </div>
                          )) : "Unlimited"}
                        </td>
                        {/* <td className="py-2 text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUpdateClick(key);
                              }}
                            >
                              Update
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteClick(key);
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </td> */}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-center mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchApiKeys(cursor)}
                  disabled={!hasMore || isLoading}
                >
                  {isLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading...
                    </div>
                  ) : hasMore ? (
                    "Load More"
                  ) : (
                    "No More Data"
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <ApiKeyGenerateModal
        isOpen={showGenerateModal}
        onClose={() => setShowGenerateModal(false)}
        onSuccess={() => fetchApiKeys()}
      />
      <Dialog open={showDeleteModal} onOpenChange={setShowDeleteModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API Key</DialogTitle>
            <DialogDescription className="text-destructive">
              Are you sure you want to delete this API key? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteModal(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showUpdateModal} onOpenChange={setShowUpdateModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <Switch
                checked={selectedKey?.status === "ACTIVE"}
                onCheckedChange={async (checked) => {
                  if (!selectedKey) return;
                  try {
                    const response = await fetch('/api/api-keys/update', {
                      method: 'PATCH',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${state.apiKey}`
                      },
                      body: JSON.stringify({
                        apiKey: selectedKey.apiKey,
                        status: checked ? "ACTIVE" : "INACTIVE"
                      })
                    });

                    if (!response.ok) throw new Error('Failed to update API key');
                    
                    await fetchApiKeys();
                    setShowUpdateModal(false);
                    setSelectedKey(null);
                    toast.success('API key updated successfully');
                  } catch (error) {
                    console.error('Failed to update API key:', error);
                    toast.error('Failed to update API key');
                  }
                }}
              />
              <label>Active</label>
            </div>
          </div>
          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => setShowUpdateModal(false)}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
} 