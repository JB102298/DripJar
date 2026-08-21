/**
 * Date picker — precision panes and long-horizon reach (Owner QA item 8).
 *
 * The old picker had one pane and two arrows that stepped a single month.
 * Reaching a newborn's college-fund target — eighteen years out — took 216
 * taps and there was no other route. These tests assert the two things that
 * fixes: a year can be picked directly, and a coarse precision never puts a day
 * grid in front of someone who was not asked for a day.
 *
 * `date-precision.test.ts` covers the maths. This covers the component actually
 * using it, which is where the equivalent bug would live.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@/hooks/useColors", () => ({
  useColors: () => new Proxy({}, { get: () => "#000000" }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("@react-native-community/datetimepicker", () => ({ default: () => null }));

import { CalendarPicker } from "../components/CalendarPicker";
import { DateInput } from "../components/DateInput";
import { toLocalISO } from "../lib/date-precision";

afterEach(cleanup);

const THIS_YEAR = new Date().getFullYear();

describe("year precision", () => {
  it("opens on the year pane and never shows a day grid", () => {
    render(<CalendarPicker value={undefined} onChange={vi.fn()} precision="year" />);

    expect(screen.getByTestId(`calendar-year-${THIS_YEAR}`)).toBeTruthy();
    // No day cells at all — the question was never about a day.
    expect(screen.queryByTestId(`calendar-day-${THIS_YEAR}-1-1`)).toBeNull();
  });

  it("commits 1 January of the chosen year", () => {
    const onChange = vi.fn();
    render(<CalendarPicker value={undefined} onChange={onChange} precision="year" />);

    fireEvent.click(screen.getByTestId(`calendar-year-${THIS_YEAR + 3}`));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(toLocalISO(onChange.mock.calls[0]![0] as Date)).toBe(`${THIS_YEAR + 3}-01-01`);
  });

  it("reaches an eighteen-year horizon by paging, not by stepping months", () => {
    render(<CalendarPicker value={undefined} onChange={vi.fn()} precision="year" />);

    const target = THIS_YEAR + 18;
    let steps = 0;
    while (screen.queryByTestId(`calendar-year-${target}`) === null && steps < 5) {
      fireEvent.click(screen.getByTestId("calendar-step-forward"));
      steps += 1;
    }

    expect(screen.getByTestId(`calendar-year-${target}`)).toBeTruthy();
    // The old picker needed 216 month steps. Anything in single digits is a
    // categorical improvement; this pins it far below that.
    expect(steps).toBeLessThanOrEqual(2);
  });
});

describe("monthYear precision", () => {
  it("opens on the month pane and never shows a day grid", () => {
    render(<CalendarPicker value={undefined} onChange={vi.fn()} precision="monthYear" />);

    expect(screen.getByTestId(`calendar-month-${THIS_YEAR}-3`)).toBeTruthy();
    expect(screen.queryByTestId(`calendar-day-${THIS_YEAR}-3-1`)).toBeNull();
  });

  it("commits the 1st of the chosen month", () => {
    const onChange = vi.fn();
    render(<CalendarPicker value={undefined} onChange={onChange} precision="monthYear" />);

    fireEvent.click(screen.getByTestId(`calendar-month-${THIS_YEAR}-7`));

    expect(toLocalISO(onChange.mock.calls[0]![0] as Date)).toBe(`${THIS_YEAR}-07-01`);
  });

  it("zooms out to the year pane from the header label", () => {
    const onChange = vi.fn();
    render(<CalendarPicker value={undefined} onChange={onChange} precision="monthYear" />);

    fireEvent.click(screen.getByTestId("calendar-header-label"));
    expect(screen.getByTestId(`calendar-year-${THIS_YEAR}`)).toBeTruthy();

    // Picking a year drops back to that year's months rather than committing.
    fireEvent.click(screen.getByTestId(`calendar-year-${THIS_YEAR + 2}`));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`calendar-month-${THIS_YEAR + 2}-3`));
    expect(toLocalISO(onChange.mock.calls[0]![0] as Date)).toBe(`${THIS_YEAR + 2}-03-01`);
  });
});

describe("exact precision", () => {
  it("opens on the day grid", () => {
    render(<CalendarPicker value={new Date(THIS_YEAR, 2, 14, 12)} onChange={vi.fn()} precision="exact" />);
    expect(screen.getByTestId(`calendar-day-${THIS_YEAR}-3-14`)).toBeTruthy();
  });

  it("navigates year → month → day directly", () => {
    const onChange = vi.fn();
    render(<CalendarPicker value={new Date(THIS_YEAR, 2, 14, 12)} onChange={onChange} precision="exact" />);

    // day → month
    fireEvent.click(screen.getByTestId("calendar-header-label"));
    expect(screen.getByTestId(`calendar-month-${THIS_YEAR}-1`)).toBeTruthy();

    // month → year
    fireEvent.click(screen.getByTestId("calendar-header-label"));
    const target = THIS_YEAR + 18;
    let steps = 0;
    while (screen.queryByTestId(`calendar-year-${target}`) === null && steps < 5) {
      fireEvent.click(screen.getByTestId("calendar-step-forward"));
      steps += 1;
    }
    fireEvent.click(screen.getByTestId(`calendar-year-${target}`));

    // year → month → day, committing a real day eighteen years out
    fireEvent.click(screen.getByTestId(`calendar-month-${target}-6`));
    fireEvent.click(screen.getByTestId(`calendar-day-${target}-6-9`));

    expect(toLocalISO(onChange.mock.calls[0]![0] as Date)).toBe(`${target}-06-09`);
  });

  it("cannot zoom out past its own terminal pane", () => {
    // A year-precision picker has nowhere coarser to go; the label must not be
    // a dead button.
    render(<CalendarPicker value={undefined} onChange={vi.fn()} precision="year" />);
    fireEvent.click(screen.getByTestId("calendar-header-label"));
    expect(screen.getByTestId(`calendar-year-${THIS_YEAR}`)).toBeTruthy();
  });
});

describe("DateInput precision selector", () => {
  it("renders the chosen value at the chosen precision", () => {
    render(
      <DateInput
        value={new Date(2044, 0, 1, 12)}
        onChange={vi.fn()}
        precision="year"
        onPrecisionChange={vi.fn()}
        testID="target"
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("2044");
    // A year-precision field must not imply a day.
    expect(text).not.toContain("January 1, 2044");
  });

  it("re-snaps an existing answer when precision is coarsened", () => {
    const onChange = vi.fn();
    const onPrecisionChange = vi.fn();
    render(
      <DateInput
        value={new Date(2044, 2, 14, 12)}
        onChange={onChange}
        precision="exact"
        onPrecisionChange={onPrecisionChange}
      />,
    );

    fireEvent.click(screen.getByTestId("date-precision-year"));

    expect(onPrecisionChange).toHaveBeenCalledWith("year");
    // The stored value must not keep a day the user no longer claims to know.
    expect(toLocalISO(onChange.mock.calls[0]![0] as Date)).toBe("2044-01-01");
  });

  it("hides the selector when precision is fixed", () => {
    render(<DateInput value={undefined} onChange={vi.fn()} precision="exact" />);
    expect(screen.queryByTestId("date-precision-year")).toBeNull();
  });
});
