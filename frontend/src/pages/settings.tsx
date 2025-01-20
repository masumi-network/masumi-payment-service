import BlinkingUnderscore from "@/components/BlinkingUnderscore";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { GetStaticProps } from 'next';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SettingsProps {
  // Add props if needed in the future
}

export const getStaticProps: GetStaticProps<SettingsProps> = async () => {
  return {
    props: {}
  };
};

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