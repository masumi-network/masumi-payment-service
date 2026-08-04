import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ChevronDown, Trash2 } from 'lucide-react';
import { type FieldArrayWithId, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { REGISTRY_LIMITS } from '@/lib/registry-validation';
import type { AgentFormValues } from './register-agent-schema';

/**
 * The collapsible "Additional Fields" block of the register/update dialog:
 * author/contact details, legal URLs, capability, and example outputs.
 */
export function RegisterAgentAdditionalSection({
  show,
  onToggle,
  register,
  errors,
  exampleOutputFields,
  appendExampleOutput,
  removeExampleOutput,
}: {
  show: boolean;
  onToggle: () => void;
  register: UseFormRegister<AgentFormValues>;
  errors: FieldErrors<AgentFormValues>;
  exampleOutputFields: FieldArrayWithId<AgentFormValues, 'exampleOutputs', 'id'>[];
  appendExampleOutput: (value: NonNullable<AgentFormValues['exampleOutputs']>[number]) => void;
  removeExampleOutput: (index: number) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={show}
        className="flex items-center gap-4 pt-2 w-full group"
      >
        <Separator className="flex-1" />
        <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground whitespace-nowrap group-hover:text-foreground transition-colors">
          Additional Fields
          <ChevronDown className={`h-4 w-4 transition-transform ${show ? 'rotate-180' : ''}`} />
        </span>
        <Separator className="flex-1" />
      </button>

      {show && (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">Author Name</label>
            <Input
              {...register('authorName')}
              placeholder="Enter the author's name"
              className={errors.authorName ? 'border-destructive' : ''}
            />
            {errors.authorName && (
              <p className="text-sm text-destructive">{errors.authorName.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Author Email</label>
            <Input
              {...register('authorEmail')}
              type="email"
              placeholder="Enter the author's email address"
              className={errors.authorEmail ? 'border-destructive' : ''}
            />
            {errors.authorEmail && (
              <p className="text-sm text-destructive">{errors.authorEmail.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Organization</label>
            <Input
              {...register('organization')}
              placeholder="Enter the organization name"
              className={errors.organization ? 'border-destructive' : ''}
            />
            {errors.organization && (
              <p className="text-sm text-destructive">{errors.organization.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Contact Other (Website, Phone...)</label>
            <Input
              {...register('contactOther')}
              placeholder="Enter other contact"
              className={errors.contactOther ? 'border-destructive' : ''}
            />
            {errors.contactOther && (
              <p className="text-sm text-destructive">{errors.contactOther.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Terms of Use URL</label>
            <Input
              {...register('termsOfUseUrl')}
              placeholder="Enter the terms of use URL"
              className={errors.termsOfUseUrl ? 'border-destructive' : ''}
            />
            {errors.termsOfUseUrl && (
              <p className="text-sm text-destructive">{errors.termsOfUseUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Privacy Policy URL</label>
            <Input
              {...register('privacyPolicyUrl')}
              placeholder="Enter the privacy policy URL"
              className={errors.privacyPolicyUrl ? 'border-destructive' : ''}
            />
            {errors.privacyPolicyUrl && (
              <p className="text-sm text-destructive">{errors.privacyPolicyUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Other URL (Support...)</label>
            <Input
              {...register('otherUrl')}
              placeholder="Enter the other URL"
              className={errors.otherUrl ? 'border-destructive' : ''}
            />
            {errors.otherUrl && (
              <p className="text-sm text-destructive">{errors.otherUrl.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Capability Name</label>
              <Input
                {...register('capabilityName')}
                placeholder="e.g., Text Generation"
                className={errors.capabilityName ? 'border-destructive' : ''}
              />
              {errors.capabilityName && (
                <p className="text-sm text-destructive">{errors.capabilityName.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Capability Version</label>
              <Input
                {...register('capabilityVersion')}
                placeholder="e.g., 1.0.0"
                className={errors.capabilityVersion ? 'border-destructive' : ''}
              />
              {errors.capabilityVersion && (
                <p className="text-sm text-destructive">{errors.capabilityVersion.message}</p>
              )}
            </div>
          </div>

          <div className="space-y-4 border rounded-md p-4 bg-muted/40">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Example Outputs</label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={exampleOutputFields.length >= REGISTRY_LIMITS.exampleOutputCount}
                onClick={() => appendExampleOutput({ name: '', url: '', mimeType: '' })}
              >
                Add Example
              </Button>
            </div>
            {exampleOutputFields.map((field, index) => (
              <div key={field.id} className="p-4 border rounded-md space-y-2 relative">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Input
                    placeholder="Name"
                    {...register(`exampleOutputs.${index}.name` as const)}
                  />
                  <Input placeholder="URL" {...register(`exampleOutputs.${index}.url` as const)} />
                  <Input
                    placeholder="MIME Type"
                    {...register(`exampleOutputs.${index}.mimeType` as const)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove example output"
                  onClick={() => removeExampleOutput(index)}
                  className="absolute top-2 right-2"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
