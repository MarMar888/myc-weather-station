"use client";

import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { STATION_LIST, getStation, type StationId } from "@/lib/stations";

// Top-right reader switcher. Lets you flip between tenants (Minnetonka YC,
// Lake Mendota buoy) while staying on the current tab.
export function StationSwitcher({
  station,
  onSelect,
}: {
  station: StationId;
  onSelect: (id: StationId) => void;
}) {
  const current = getStation(station);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--hairline)] px-3 font-mono text-xs text-[var(--ink-soft)] transition-colors hover:text-[var(--ink)] data-[state=open]:text-[var(--ink)]"
        >
          <span className="size-1.5 rounded-full bg-[var(--accent)]" />
          {current.short}
          <ChevronDown className="size-3.5 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[200px] overflow-hidden rounded-md border border-[var(--hairline)] bg-[var(--panel)] p-1 shadow-2xl"
        >
          {STATION_LIST.map((s) => {
            const active = s.id === station;
            return (
              <DropdownMenu.Item
                key={s.id}
                onSelect={() => onSelect(s.id)}
                className="flex cursor-pointer items-start gap-2 rounded px-2.5 py-2 text-sm outline-none transition-colors data-[highlighted]:bg-[var(--panel-2)]"
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {active && <Check className="size-3.5 text-[var(--accent)]" />}
                </span>
                <span className="flex flex-col">
                  <span className="font-medium text-[var(--ink)]">{s.short}</span>
                  <span className="font-mono text-[10px] text-[var(--ink-faint)]">{s.name}</span>
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
