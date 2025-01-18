import BlinkingUnderscore from "@/components/BlinkingUnderscore";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function Settings() {
  return (
    <MainLayout>
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            <BlinkingUnderscore />
          </div>
        </CardContent>
      </Card>
    </MainLayout>
  );
} 