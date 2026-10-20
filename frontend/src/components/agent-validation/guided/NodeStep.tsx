import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNodeChecks } from '@/lib/hooks/useNodeChecks';
import { CheckList } from '../CheckList';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

/** Is the node set up and funded well enough for what comes next? */
export function NodeStep({ wizard }: { wizard: WizardApi }) {
  const { runFresh } = useNodeChecks();
  const [isRunning, setIsRunning] = useState(false);
  const result = wizard.state.results.node;

  async function run() {
    setIsRunning(true);
    try {
      wizard.record('node', await runFresh());
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <StepFrame
      title="Is your node ready?"
      description="Checks the payment source and wallets, and whether the wallets hold enough to register an agent and run a test purchase."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={run} disabled={isRunning}>
          {isRunning ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
          {result ? 'Run the checks again' : 'Run the checks'}
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/wallets">Open Wallets</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/setup">Open Setup</Link>
        </Button>
      </div>
      {result && <CheckList checks={result.checks} />}
    </StepFrame>
  );
}
