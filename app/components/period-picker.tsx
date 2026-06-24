import { Fragment, useState } from "react";

import {
  PERIOD_PRESET_GROUPS,
  presetLabel,
  rangeForPreset,
  shiftDay,
  toReportDay,
  type DayRange,
} from "../lib/periods";

// Shopify-admin-style date range picker: quick-pick sidebar on the left,
// Starting/Ending fields + two month calendars on the right, Cancel/Apply
// footer. Selection is staged locally; Apply hands the preset + range to the
// parent (which navigates), Cancel/reopen revert to the applied values.

const POPOVER_ID = "analytics-period-popover";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const monthOf = (day: string) => day.slice(0, 7);

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Left calendar month for a range: the range's start month, except when the
// whole range sits in the current month — then current month goes on the
// right calendar (matching the admin picker).
function leftViewFor(range: DayRange, today: string): string {
  const startMonth = monthOf(range.start);
  if (monthOf(range.end) === startMonth && startMonth === monthOf(today)) {
    return addMonths(startMonth, -1);
  }
  return startMonth;
}

function QuickPick({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        border: "none",
        borderRadius: 8,
        background: selected ? "rgba(0, 0, 0, 0.08)" : "transparent",
        fontFamily: "inherit",
        fontSize: 13,
        color: "inherit",
        fontWeight: selected ? 600 : 400,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function PeriodPicker({
  preset,
  range,
  onApply,
}: {
  preset: string;
  range: DayRange;
  onApply: (preset: string, range: DayRange) => void;
}) {
  const today = toReportDay(new Date());

  const [draftPreset, setDraftPreset] = useState(preset);
  const [start, setStart] = useState(range.start);
  const [end, setEnd] = useState(range.end); // "" while an end pick is pending
  const [startText, setStartText] = useState(range.start);
  const [endText, setEndText] = useState(range.end);
  const [view, setView] = useState(() => leftViewFor(range, today));

  const setDraft = (nextPreset: string, nextStart: string, nextEnd: string) => {
    setDraftPreset(nextPreset);
    setStart(nextStart);
    setEnd(nextEnd);
    setStartText(nextStart);
    setEndText(nextEnd);
    if (nextStart) {
      setView(leftViewFor({ start: nextStart, end: nextEnd || nextStart }, today));
    }
  };

  const resetToApplied = () => setDraft(preset, range.start, range.end);

  const pickPreset = (value: string) => {
    const picked = rangeForPreset(value, today);
    if (picked) setDraft(value, picked.start, picked.end);
  };

  // Both calendars report here; a first click arrives as "YYYY-MM-DD--".
  const handleCalendarValue = (value: string) => {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})--(\d{4}-\d{2}-\d{2})?$/);
    if (!match) return;
    setDraftPreset("custom");
    setStart(match[1]);
    setStartText(match[1]);
    setEnd(match[2] ?? "");
    setEndText(match[2] ?? "");
  };

  const commitField = (which: "start" | "end", raw: string) => {
    const value = raw.trim();
    if (!DAY_RE.test(value) || value > today) {
      setStartText(start);
      setEndText(end);
      return;
    }
    let nextStart = which === "start" ? value : start;
    let nextEnd = which === "end" ? value : end;
    if (nextStart && nextEnd && nextStart > nextEnd) {
      [nextStart, nextEnd] = [nextEnd, nextStart];
    }
    setDraft("custom", nextStart, nextEnd);
  };

  // The popover is closed declaratively by command="--hide" on the footer
  // buttons (the documented way); these handlers only stage the result.
  const apply = () => {
    if (!start || !end) return;
    onApply(draftPreset, { start, end });
  };

  const cancel = () => resetToApplied();

  const calendarValue = end ? `${start}--${end}` : start ? `${start}--` : "";
  const disallowFuture = `${shiftDay(today, 1)}--`;
  const triggerLabel =
    presetLabel(preset) ?? `${formatDay(range.start)} – ${formatDay(range.end)}`;

  return (
    <>
      <s-button icon="calendar" commandFor={POPOVER_ID} command="--toggle">
        {triggerLabel}
      </s-button>
      <s-popover id={POPOVER_ID} onShow={resetToApplied}>
        <div style={{ display: "flex" }}>
          <div
            style={{
              width: 170,
              flexShrink: 0,
              padding: 8,
              borderRight: "1px solid #e1e3e5",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {PERIOD_PRESET_GROUPS.map((group, index) => (
              <Fragment key={group[0].value}>
                {index > 0 && <s-divider />}
                {group.map((def) => (
                  <QuickPick
                    key={def.value}
                    selected={draftPreset === def.value}
                    onClick={() => pickPreset(def.value)}
                  >
                    {def.label}
                  </QuickPick>
                ))}
              </Fragment>
            ))}
            <s-divider />
            <QuickPick
              selected={draftPreset === "custom"}
              onClick={() => setDraftPreset("custom")}
            >
              Custom range
            </QuickPick>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{ display: "flex", gap: 8, alignItems: "center", padding: 12 }}
            >
              <s-text-field
                label="Starting"
                labelAccessibilityVisibility="exclusive"
                placeholder="YYYY-MM-DD"
                value={startText}
                onInput={(event) => setStartText(event.currentTarget.value)}
                onChange={(event) =>
                  commitField("start", event.currentTarget.value)
                }
              />
              <s-icon type="arrow-right" color="subdued" />
              <s-text-field
                label="Ending"
                labelAccessibilityVisibility="exclusive"
                placeholder="YYYY-MM-DD"
                value={endText}
                onInput={(event) => setEndText(event.currentTarget.value)}
                onChange={(event) => commitField("end", event.currentTarget.value)}
              />
            </div>
            <div style={{ display: "flex", gap: 12, padding: "0 12px 12px" }}>
              <s-date-picker
                type="range"
                value={calendarValue}
                view={view}
                disallow={disallowFuture}
                onInput={(event) => handleCalendarValue(event.currentTarget.value)}
                onChange={(event) => handleCalendarValue(event.currentTarget.value)}
                onViewChange={(event) => {
                  const next = event.currentTarget.view;
                  if (next !== view) setView(next);
                }}
              />
              <s-date-picker
                type="range"
                value={calendarValue}
                view={addMonths(view, 1)}
                disallow={disallowFuture}
                onInput={(event) => handleCalendarValue(event.currentTarget.value)}
                onChange={(event) => handleCalendarValue(event.currentTarget.value)}
                onViewChange={(event) => {
                  const next = addMonths(event.currentTarget.view, -1);
                  if (next !== view) setView(next);
                }}
              />
            </div>
            <s-divider />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                padding: 12,
              }}
            >
              <s-button commandFor={POPOVER_ID} command="--hide" onClick={cancel}>
                Cancel
              </s-button>
              <s-button
                variant="primary"
                disabled={!start || !end}
                commandFor={POPOVER_ID}
                command="--hide"
                onClick={apply}
              >
                Apply
              </s-button>
            </div>
          </div>
        </div>
      </s-popover>
    </>
  );
}
