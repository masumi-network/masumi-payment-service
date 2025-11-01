import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useSearch, SearchableItem } from '@/lib/hooks/useSearch';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const router = useRouter();
  const { searchQuery, setSearchQuery, searchResults, handleSearch } =
    useSearch();

  const handleSearchSelect = (result: SearchableItem) => {
    onOpenChange(false);
    router.push(result.href).then(() => {
      if (result.elementId) {
        setTimeout(() => {
          const element = document.getElementById(result.elementId || '');
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight-element');
            setTimeout(() => {
              element.classList.remove('highlight-element');
            }, 4000);
          }
        }, 100);
      }
    });
  };

  const handleCommandSelect = (value: string) => {
    const result = searchResults.find((r) => r.id === value);
    if (result) {
      handleSearchSelect(result);
    }
  };

  // Clear search when dialog closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open, setSearchQuery]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Command className="py-2">
          <CommandInput
            placeholder="Type to search..."
            value={searchQuery}
            onValueChange={(value) => {
              setSearchQuery(value);
              handleSearch(value);
            }}
            className="p-1 px-2 mb-2"
          />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {searchResults.map((result) => (
                <CommandItem
                  key={result.id}
                  onSelect={() => handleCommandSelect(result.id)}
                  onClick={() => handleCommandSelect(result.id)}
                  className="flex flex-col items-start p-2 cursor-pointer pointer-events-auto"
                  style={{ cursor: 'pointer', pointerEvents: 'all' }}
                >
                  <div className="font-medium">{result.title || '...'}</div>
                  {result.description && (
                    <div className="text-sm text-muted-foreground">
                      {result.description}
                    </div>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
