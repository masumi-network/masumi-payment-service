import type { RegistryEntry } from '@/lib/api/generated';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  hasExampleOutputs,
  hasMeaningfulAuthor,
  hasMeaningfulCapability,
  hasMeaningfulLegal,
  shouldShowAdditionalDetailsSection,
} from '@/lib/agent-metadata-visibility';
import {
  MetadataField,
  MetadataFields,
  MetadataLinkValue,
  MetadataPlainValue,
  formatMetadataLinkLabel,
} from './agent-metadata-fields';

type AgentMetadata = Pick<RegistryEntry, 'Author' | 'Legal' | 'Capability' | 'ExampleOutputs'>;

export function AgentAdditionalDetails({ agent }: { agent: AgentMetadata }) {
  const showAdditionalDetails = shouldShowAdditionalDetailsSection(agent);
  const showAuthor = hasMeaningfulAuthor(agent.Author);
  const showLegal = hasMeaningfulLegal(agent.Legal);
  const showCapability = hasMeaningfulCapability(agent.Capability);
  const showExampleOutputs = hasExampleOutputs(agent.ExampleOutputs);

  return (
    <>
      {showAdditionalDetails ? (
        <div className="flex items-center gap-4 pt-2">
          <Separator className="flex-1" />
          <h3 className="text-sm font-medium text-muted-foreground whitespace-nowrap">
            Additional Details
          </h3>
          <Separator className="flex-1" />
        </div>
      ) : null}

      {/* Author and Legal */}
      {showAuthor || showLegal ? (
        <div className={cn('grid grid-cols-1 gap-4', showAuthor && showLegal && 'md:grid-cols-2')}>
          {showAuthor ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Author</CardTitle>
              </CardHeader>
              <CardContent>
                <MetadataFields>
                  {agent.Author.name ? (
                    <MetadataField label="Name">
                      <MetadataPlainValue>{agent.Author.name}</MetadataPlainValue>
                    </MetadataField>
                  ) : null}
                  {agent.Author.contactEmail ? (
                    <MetadataField label="Email">
                      <MetadataLinkValue
                        href={`mailto:${agent.Author.contactEmail}`}
                        label={agent.Author.contactEmail}
                        showExternalIcon={false}
                      />
                    </MetadataField>
                  ) : null}
                  {agent.Author.organization ? (
                    <MetadataField label="Organization">
                      <MetadataPlainValue>{agent.Author.organization}</MetadataPlainValue>
                    </MetadataField>
                  ) : null}
                  {agent.Author.contactOther ? (
                    <MetadataField label="Website">
                      <MetadataLinkValue
                        href={agent.Author.contactOther}
                        label={formatMetadataLinkLabel(agent.Author.contactOther)}
                      />
                    </MetadataField>
                  ) : null}
                </MetadataFields>
              </CardContent>
            </Card>
          ) : null}
          {showLegal ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Legal</CardTitle>
              </CardHeader>
              <CardContent>
                <MetadataFields>
                  {agent.Legal?.terms ? (
                    <MetadataField label="Terms of use">
                      <MetadataLinkValue
                        href={agent.Legal.terms}
                        label={formatMetadataLinkLabel(agent.Legal.terms)}
                      />
                    </MetadataField>
                  ) : null}
                  {agent.Legal?.privacyPolicy ? (
                    <MetadataField label="Privacy policy">
                      <MetadataLinkValue
                        href={agent.Legal.privacyPolicy}
                        label={formatMetadataLinkLabel(agent.Legal.privacyPolicy)}
                      />
                    </MetadataField>
                  ) : null}
                  {agent.Legal?.other ? (
                    <MetadataField label="Support">
                      <MetadataLinkValue
                        href={agent.Legal.other}
                        label={formatMetadataLinkLabel(agent.Legal.other)}
                      />
                    </MetadataField>
                  ) : null}
                </MetadataFields>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* Capability */}
      {showCapability ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Capability</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex justify-between text-sm py-2 px-3 bg-muted/40 border rounded-md">
              <span className="text-muted-foreground">Model</span>
              <span>
                {agent.Capability.name} (v
                {agent.Capability.version})
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Example Outputs */}
      {showExampleOutputs ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Example Outputs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {agent.ExampleOutputs.map((output, index) => (
                <div key={index} className="text-sm py-2 px-3 bg-muted/40 border rounded-md">
                  <div className="flex justify-between items-center gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{output.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{output.mimeType}</p>
                    </div>
                    <a
                      href={output.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1 shrink-0"
                    >
                      View <Link2 className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
