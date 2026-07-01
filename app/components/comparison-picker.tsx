import { useRef, type ElementRef } from "react";

import {
  COMPARISON_OPTIONS,
  comparisonRange,
  formatDay,
  type ComparisonMode,
  type DayRange,
} from "../lib/periods";
import { QuickPick } from "./period-picker";

// Native-analytics-style comparison control: a calendar-compare button
// labeled with the resolved compare window, opening an option list. Unlike
// the period picker there is no staging — picking an option applies it
// (the parent navigates).

const POPOVER_ID = "analytics-comparison-popover";

export function ComparisonPicker({
  compare,
  range,
  onSelect,
}: {
  compare: ComparisonMode;
  range: DayRange;
  onSelect: (mode: ComparisonMode) => void;
}) {
  const popover = useRef<ElementRef<"s-popover">>(null);
  const lyRange = comparisonRange(compare, range);

  // s-popover has no public close method (hideOverlay lives on the modal
  // class), so close via its "--hide" command — the same mechanism
  // commandFor buttons use — with a method call if a future version adds one.
  const closePopover = () => {
    const el = popover.current as
      | (HTMLElement & { hideOverlay?: () => void })
      | null;
    if (!el) return;
    if (typeof el.hideOverlay === "function") el.hideOverlay();
    else
      el.dispatchEvent(
        Object.assign(new Event("command"), { command: "--hide" }),
      );
  };

  return (
    <>
      <s-button
        icon="calendar-compare"
        commandFor={POPOVER_ID}
        command="--toggle"
      >
        {`${formatDay(lyRange.start)} – ${formatDay(lyRange.end)}`}
      </s-button>
      <s-popover id={POPOVER_ID} ref={popover}>
        <div
          style={{
            width: 260,
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {COMPARISON_OPTIONS.map((option) => (
            <QuickPick
              key={option.value}
              selected={option.value === compare}
              onClick={() => {
                // Navigate first: closing must never be able to block the
                // selection from applying.
                if (option.value !== compare) onSelect(option.value);
                closePopover();
              }}
            >
              {option.label}
            </QuickPick>
          ))}
        </div>
      </s-popover>
    </>
  );
}
