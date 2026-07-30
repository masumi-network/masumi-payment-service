import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  type FieldErrors,
  type UseFormRegister,
  type UseFormSetValue,
  type UseFormWatch,
} from 'react-hook-form';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import type { AgentFormValues } from './register-agent-schema';

/**
 * Core agent metadata fields of the register/update dialog: API URL, name,
 * description, and tags (including the tag-input scratch state).
 */
export function RegisterAgentDetailsSection({
  register,
  errors,
  watch,
  setValue,
  typeLocked = false,
  isV2Target = false,
}: {
  register: UseFormRegister<AgentFormValues>;
  errors: FieldErrors<AgentFormValues>;
  watch: UseFormWatch<AgentFormValues>;
  setValue: UseFormSetValue<AgentFormValues>;
  // Update mode: the agent type is fixed (the update route is Standard-only for
  // now), so the selector is disabled to avoid an unsupported type change.
  typeLocked?: boolean;
  isV2Target?: boolean;
}) {
  const tags = watch('tags');
  const agentType = watch('agentType');
  const [tagInput, setTagInput] = useState('');

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tags.length >= REGISTRY_LIMITS.tagCount) {
      return;
    }

    if (tag && !tags.includes(tag)) {
      setValue('tags', [...tags, tag]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setValue(
      'tags',
      tags.filter((tag) => tag !== tagToRemove),
    );
  };

  return (
    <>
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Agent Type <span className="text-destructive">*</span>
        </label>
        {/* No field-clearing on change: only the active type's endpoint field is
            sent in the payload, so a hidden value from another type is harmless
            and keeping it preserves input if the user toggles back. */}
        <select
          {...register('agentType')}
          disabled={typeLocked}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="Standard">Standard — single API base URL</option>
          <option value="OpenApi">OpenAPI — link to a spec document</option>
          <option value="X402">x402 — link to a resource manifest</option>
          {isV2Target && <option value="A2A">A2A — MIP-002 agent card</option>}
        </select>
        <p className="text-xs text-muted-foreground">
          How this agent&apos;s API is described. Payment is configured separately below.
        </p>
      </div>

      {agentType === 'Standard' && (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            API URL <span className="text-destructive">*</span>
          </label>
          <Input
            {...register('apiUrl')}
            placeholder="Enter the API URL for your agent"
            className={errors.apiUrl ? 'border-destructive' : ''}
          />
          {errors.apiUrl && <p className="text-sm text-destructive">{errors.apiUrl.message}</p>}
        </div>
      )}

      {agentType === 'OpenApi' && (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            OpenAPI Spec URL <span className="text-destructive">*</span>
          </label>
          <Input
            {...register('openApiSpecUrl')}
            placeholder="https://your-agent.example/openapi.json (JSON or YAML)"
            className={errors.openApiSpecUrl ? 'border-destructive' : ''}
          />
          {errors.openApiSpecUrl && (
            <p className="text-sm text-destructive">{errors.openApiSpecUrl.message}</p>
          )}
        </div>
      )}

      {agentType === 'X402' && (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            x402 Resource Manifest URL <span className="text-destructive">*</span>
          </label>
          <Input
            {...register('x402ResourcesUrl')}
            placeholder="https://your-agent.example/.well-known/x402.json"
            className={errors.x402ResourcesUrl ? 'border-destructive' : ''}
          />
          {errors.x402ResourcesUrl && (
            <p className="text-sm text-destructive">{errors.x402ResourcesUrl.message}</p>
          )}
        </div>
      )}

      {agentType === 'A2A' && (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">
              API URL <span className="text-destructive">*</span>
            </label>
            <Input
              {...register('apiUrl')}
              placeholder="Enter the API URL for your agent"
              className={errors.apiUrl ? 'border-destructive' : ''}
            />
            {errors.apiUrl && <p className="text-sm text-destructive">{errors.apiUrl.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Agent Card URL <span className="text-destructive">*</span>
            </label>
            <Input
              {...register('a2aAgentCardUrl')}
              placeholder="https://your-agent.example/.well-known/agent-card.json"
              className={errors.a2aAgentCardUrl ? 'border-destructive' : ''}
            />
            {errors.a2aAgentCardUrl && (
              <p className="text-sm text-destructive">{errors.a2aAgentCardUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              A2A Protocol Versions <span className="text-destructive">*</span>
            </label>
            <Input
              {...register('a2aProtocolVersions')}
              placeholder="1.0"
              className={errors.a2aProtocolVersions ? 'border-destructive' : ''}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated list of A2A protocol versions this agent supports. Must appear in the
              Agent Card&apos;s protocolVersions.
            </p>
            {errors.a2aProtocolVersions && (
              <p className="text-sm text-destructive">{errors.a2aProtocolVersions.message}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="skipAgentCardValidation"
              {...register('skipAgentCardValidation')}
              className="h-4 w-4 rounded border-input"
            />
            <label htmlFor="skipAgentCardValidation" className="text-sm text-muted-foreground">
              Register even if the agent card can&apos;t be fetched or validated right now
            </label>
          </div>
        </>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium">
          Name <span className="text-destructive">*</span>
        </label>
        <Input
          {...register('name')}
          placeholder="Enter a name for your agent"
          className={errors.name ? 'border-destructive' : ''}
        />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          Description <span className="text-destructive">*</span>
        </label>
        <div className="relative">
          <Textarea
            {...register('description')}
            placeholder="Describe what your agent does"
            rows={3}
            className={`resize-none overflow-y-auto h-[84px] ${errors.description ? 'border-destructive' : ''}`}
            maxLength={250}
          />
          <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
            {watch('description')?.length || 0}/250
          </div>
        </div>
        {errors.description && (
          <p className="text-sm text-destructive">{errors.description.message}</p>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">
          Tags <span className="text-destructive">*</span>
        </label>
        <div>
          <div className="flex gap-2">
            <Input
              placeholder="Add a tag"
              value={tagInput}
              maxLength={REGISTRY_LIMITS.tag}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleAddTag();
                }
              }}
              className={errors.tags ? 'border-destructive' : ''}
            />
            <Button
              type="button"
              variant="outline"
              disabled={tags.length >= REGISTRY_LIMITS.tagCount}
              onClick={handleAddTag}
            >
              Add
            </Button>
          </div>
          {errors.tags ? <p className="text-sm text-destructive">{errors.tags.message}</p> : null}
          {tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map((tag: string) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="cursor-pointer"
                  onClick={() => handleRemoveTag(tag)}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
