import type { RegistryEntry } from '@/lib/api/generated';

type Author = RegistryEntry['Author'];
type Legal = RegistryEntry['Legal'];
type Capability = RegistryEntry['Capability'];

/** True when at least one author field carries a non-empty value. */
export function hasMeaningfulAuthor(author: Author | undefined | null): boolean {
  if (!author) return false;
  return Boolean(
    author.name?.trim() ||
    author.contactEmail?.trim() ||
    author.organization?.trim() ||
    author.contactOther?.trim(),
  );
}

/** True when at least one legal link is present. */
export function hasMeaningfulLegal(legal: Legal | undefined | null): boolean {
  if (!legal) return false;
  return Boolean(legal.terms?.trim() || legal.privacyPolicy?.trim() || legal.other?.trim());
}

/** True when capability name or version is set. */
export function hasMeaningfulCapability(capability: Capability | undefined | null): boolean {
  if (!capability) return false;
  return Boolean(capability.name?.trim() || capability.version?.trim());
}

/** True when the agent has at least one example output. */
export function hasExampleOutputs(
  outputs: RegistryEntry['ExampleOutputs'] | undefined | null,
): boolean {
  return (outputs?.length ?? 0) > 0;
}

/** Whether the Additional Details block (divider + cards) should render. */
export function shouldShowAdditionalDetailsSection(
  agent: Pick<RegistryEntry, 'Author' | 'Legal' | 'Capability' | 'ExampleOutputs'>,
): boolean {
  return (
    hasMeaningfulAuthor(agent.Author) ||
    hasMeaningfulLegal(agent.Legal) ||
    hasMeaningfulCapability(agent.Capability) ||
    hasExampleOutputs(agent.ExampleOutputs)
  );
}
