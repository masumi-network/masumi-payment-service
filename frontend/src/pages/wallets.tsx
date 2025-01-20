import { MainLayout } from "@/components/layout/MainLayout";
import { GetStaticProps } from 'next';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface WalletsProps {
  // Add props if needed in the future
}

export const getStaticProps: GetStaticProps<WalletsProps> = async () => {
  return {
    props: {}
  };
};

export default function Wallets() {
  return (
    <MainLayout>
      <div>
        <h1>Wallets</h1>
      </div>
    </MainLayout>
  );
} 