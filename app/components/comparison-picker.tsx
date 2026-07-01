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
  // hideOverlay exists at runtime (BaseOverlayMethods) but is missing from
  // polaris-types' generated Popover class.
  const popover = useRef<ElementRef<"s-popover"> & { hideOverlay(): void }>(
    null,
  );
  const lyRange = comparisonRange(compare, range);

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
                popover.current?.hideOverlay();
                if (option.value !== compare) onSelect(option.value);
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
