import Head from 'next/head';
import { useRouter } from 'next/router';
import type { GetStaticProps } from 'next';
import { GuidedWizard } from '@/components/agent-validation/guided/GuidedWizard';
import { ToolsTab } from '@/components/agent-validation/ToolsTab';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Tabs } from '@/components/ui/tabs';
import { useAppContext } from '@/lib/contexts/AppContext';

export const getStaticProps: GetStaticProps = async () => {
  return {
    props: {},
  };
};

const TABS = [{ name: 'Guided' }, { name: 'Tools' }];

export default function AgentValidation() {
  const router = useRouter();
  const { network } = useAppContext();
  const activeTab = router.query.tab === 'tools' ? 'Tools' : 'Guided';

  function changeTab(name: string) {
    void router.replace(
      { pathname: router.pathname, query: { tab: name === 'Tools' ? 'tools' : 'guided' } },
      undefined,
      { shallow: true },
    );
  }

  return (
    <>
      <Head>
        <title>Agent validation | Admin Interface</title>
      </Head>
      <MainLayout>
        <AnimatedPage>
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Agent validation</h1>
              <p className="text-sm text-muted-foreground">
                Get an agent from idea to listed and tested, with the reason and the fix for
                everything that is wrong.
              </p>
            </div>

            <Tabs tabs={TABS} activeTab={activeTab} onTabChange={changeTab} />

            {activeTab === 'Guided' ? <GuidedWizard key={network} /> : <ToolsTab />}
          </div>
        </AnimatedPage>
      </MainLayout>
    </>
  );
}
