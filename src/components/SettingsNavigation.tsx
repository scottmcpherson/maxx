import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Icons } from "./Icons";

export type SettingsSection =
  | "providers"
  | "voice"
  | "connections"
  | "keyboardShortcuts"
  | "experimental";

export function SettingsNavigation({
  query,
  onQueryChange,
  onBack,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-3">
      <Button type="button" variant="sidebar" size="sm" className="h-[30px] w-full justify-start" onClick={onBack}>
        <Icons.chevronLeft data-icon="inline-start" />
        <span>Back</span>
      </Button>

      <Field>
        <FieldLabel htmlFor="settings-search" className="sr-only">Search settings</FieldLabel>
        <InputGroup className="h-7">
          <InputGroupAddon>
            <Icons.search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id="settings-search"
            value={query}
            aria-label="Search settings"
            placeholder="Search Settings"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </InputGroup>
      </Field>

      <TabsList variant="sidebar" className="min-h-0 flex-1 justify-start overflow-y-auto" aria-label="Settings sections">
        <TabsTrigger variant="sidebar" value="providers"><Icons.activity data-icon="inline-start" />Providers</TabsTrigger>
        <TabsTrigger variant="sidebar" value="voice"><Icons.microphone data-icon="inline-start" />Voice</TabsTrigger>
        <TabsTrigger variant="sidebar" value="connections"><Icons.computer data-icon="inline-start" />Connections</TabsTrigger>
        <TabsTrigger variant="sidebar" value="keyboardShortcuts"><Icons.keyboard data-icon="inline-start" />Keyboard Shortcuts</TabsTrigger>
        <TabsTrigger variant="sidebar" value="experimental"><Icons.flask data-icon="inline-start" />Experimental</TabsTrigger>
      </TabsList>
    </div>
  );
}
