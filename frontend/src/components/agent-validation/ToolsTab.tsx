import Link from 'next/link';
import { useRouter } from 'next/router';
import { ArrowUpRight } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { EndpointChecker } from './EndpointChecker';
import { HashTool } from './HashTool';
import { JobRunnerTool } from './JobRunnerTool';
import { NodeCheck } from './NodeCheck';
import { RegistryStatusTool } from './RegistryStatusTool';
import { SchemaTool } from './SchemaTool';

type Tool = { name: string; slug: string; description: string };

const TOOLS: Tool[] = [
  { name: 'Node check', slug: 'node', description: 'Is the node set up and funded?' },
  {
    name: 'Endpoints',
    slug: 'endpoints',
    description: 'Call your agent like the registry and buyers do.',
  },
  {
    name: 'Schemas',
    slug: 'schemas',
    description: 'Check and build input schemas and coworker metadata.',
  },
  { name: 'Hashes', slug: 'hashes', description: 'Compute the MIP-004 and MIP-003 hashes.' },
  {
    name: 'Registry status',
    slug: 'registry',
    description: 'Why a registered agent is or is not listed.',
  },
  { name: 'Job runner', slug: 'job', description: 'Run a whole job, including payment.' },
  {
    name: 'Mock purchase',
    slug: 'purchase',
    description: 'The standalone test payment and purchase dialogs.',
  },
];

function ToolBody({ slug }: { slug: string }) {
  switch (slug) {
    case 'endpoints':
      return <EndpointChecker />;
    case 'schemas':
      return <SchemaTool />;
    case 'hashes':
      return <HashTool />;
    case 'registry':
      return <RegistryStatusTool />;
    case 'job':
      return <JobRunnerTool />;
    case 'purchase':
      return (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            The test payment, test purchase and full payment cycle dialogs work on this node alone,
            without an agent.
          </p>
          <Link
            href="/developers"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            Open Developers → Testing
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      );
    default:
      return <NodeCheck />;
  }
}

/** Every check of the guided path, available on its own. The selected tool is kept in the URL (?tool=). */
export function ToolsTab() {
  const router = useRouter();
  const slug = typeof router.query.tool === 'string' ? router.query.tool : 'node';
  const active = TOOLS.find((tool) => tool.slug === slug) ?? TOOLS[0];

  function select(name: string) {
    const tool = TOOLS.find((entry) => entry.name === name) ?? TOOLS[0];
    void router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: 'tools', tool: tool.slug } },
      undefined,
      {
        shallow: true,
      },
    );
  }

  return (
    <div className="space-y-6">
      <Tabs
        tabs={TOOLS.map((tool) => ({ name: tool.name }))}
        activeTab={active.name}
        onTabChange={select}
        className="overflow-x-auto"
      />
      <p className="text-sm text-muted-foreground">{active.description}</p>
      <ToolBody key={active.slug} slug={active.slug} />
    </div>
  );
}
