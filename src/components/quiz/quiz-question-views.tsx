"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { QuizQuestion } from "@/lib/quiz/golf-questions";

/* -------------------------------------------------------------------------- */
/* Single-select cards — auto-advance on tap (Hungry Root pattern).            */
/* -------------------------------------------------------------------------- */

export function SingleSelectView({
  question,
  value,
  freeText,
  onAnswer,
  onFreeTextChange,
  onFreeTextSubmit,
}: {
  question: Extract<QuizQuestion, { kind: "single-select" }>;
  value: string | undefined;
  freeText?: string;
  onAnswer: (value: string) => void;
  onFreeTextChange?: (value: string) => void;
  onFreeTextSubmit?: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto w-full space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {question.options.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onAnswer(opt.value)}
              className={cn(
                "group relative text-left rounded-2xl border bg-surface-raised/70 px-5 py-4 transition",
                "hover:border-foreground/40 hover:bg-surface-raised hover:scale-[1.01]",
                selected
                  ? "border-[hsl(var(--copper))] bg-[hsl(var(--copper))]/8 ring-2 ring-[hsl(var(--copper))]/30"
                  : "border-border/60",
              )}
            >
              <div className="flex items-start gap-3">
                {opt.glyph && (
                  <span className="text-2xl leading-none shrink-0 mt-0.5">
                    {opt.glyph}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-foreground leading-snug">
                    {opt.label}
                  </p>
                  {opt.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                      {opt.description}
                    </p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {question.freeTextField && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground/70">
            <div className="flex-1 h-px bg-border/60" />
            <span>{question.freeTextField.label}</span>
            <div className="flex-1 h-px bg-border/60" />
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={freeText ?? ""}
              onChange={(e) => onFreeTextChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (freeText ?? "").trim()) {
                  e.preventDefault();
                  onFreeTextSubmit?.();
                }
              }}
              placeholder={question.freeTextField.placeholder}
              className="flex-1 rounded-xl border border-border bg-surface-raised px-4 py-3 text-base"
            />
            <Button
              onClick={() => onFreeTextSubmit?.()}
              disabled={!(freeText ?? "").trim()}
              size="lg"
            >
              Continue
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Multi-select cards — needs an explicit Continue button.                     */
/* -------------------------------------------------------------------------- */

export function MultiSelectView({
  question,
  value,
  freeText,
  onChange,
  onFreeTextChange,
  onContinue,
}: {
  question: Extract<QuizQuestion, { kind: "multi-select" }>;
  value: string[] | undefined;
  freeText?: string;
  onChange: (value: string[]) => void;
  onFreeTextChange?: (value: string) => void;
  onContinue: () => void;
}) {
  const selected = value ?? [];
  const toggle = (v: string) => {
    if (selected.includes(v)) {
      onChange(selected.filter((s) => s !== v));
    } else {
      if (question.maxSelect && selected.length >= question.maxSelect) return;
      onChange([...selected, v]);
    }
  };
  const hasFreeText = (freeText ?? "").trim().length > 0;
  // minSelect can be satisfied by either picking options OR typing in the
  // free-text field — that's the universal escape hatch.
  const canContinue =
    !question.minSelect ||
    selected.length >= question.minSelect ||
    hasFreeText;

  return (
    <div className="max-w-2xl mx-auto w-full space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {question.options.map((opt) => {
          const isSelected = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              className={cn(
                "group text-left rounded-2xl border bg-surface-raised/70 px-5 py-4 transition",
                "hover:border-foreground/40 hover:bg-surface-raised",
                isSelected
                  ? "border-[hsl(var(--copper))] bg-[hsl(var(--copper))]/8 ring-2 ring-[hsl(var(--copper))]/30"
                  : "border-border/60",
              )}
            >
              <div className="flex items-start gap-3">
                {opt.glyph && (
                  <span className="text-2xl leading-none shrink-0 mt-0.5">
                    {opt.glyph}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-foreground leading-snug">
                    {opt.label}
                  </p>
                  {opt.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                      {opt.description}
                    </p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {question.freeTextField && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground/70">
            <div className="flex-1 h-px bg-border/60" />
            <span>{question.freeTextField.label}</span>
            <div className="flex-1 h-px bg-border/60" />
          </div>
          <input
            type="text"
            value={freeText ?? ""}
            onChange={(e) => onFreeTextChange?.(e.target.value)}
            placeholder={question.freeTextField.placeholder}
            className="w-full rounded-xl border border-border bg-surface-raised px-4 py-3 text-base"
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {selected.length} selected
          {question.minSelect ? ` · pick at least ${question.minSelect}` : ""}
        </p>
        <Button onClick={onContinue} disabled={!canContinue} size="lg">
          Continue
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider — single numeric value with live label.                              */
/* -------------------------------------------------------------------------- */

export function SliderView({
  question,
  value,
  onChange,
  onContinue,
}: {
  question: Extract<QuizQuestion, { kind: "slider" }>;
  value: number | undefined;
  onChange: (value: number) => void;
  onContinue: () => void;
}) {
  const current = value ?? question.defaultValue;
  const display = question.format ? question.format(current) : `${current}`;
  return (
    <div className="max-w-xl mx-auto w-full space-y-6">
      <div className="text-center space-y-2">
        <p className="text-5xl font-bold tabular-nums text-[hsl(var(--copper))]">
          {display}
        </p>
      </div>
      <input
        type="range"
        min={question.min}
        max={question.max}
        step={question.step}
        value={current}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-[hsl(var(--copper))]"
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>
          {question.format
            ? question.format(question.min)
            : question.min}
        </span>
        <span>
          {question.format
            ? question.format(question.max)
            : question.max}
        </span>
      </div>
      <div className="flex justify-center pt-2">
        <Button onClick={onContinue} size="lg">
          Continue
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Date range — two native date inputs, with a "skip / flexible" path.         */
/* -------------------------------------------------------------------------- */

export function DateRangeView({
  question,
  value,
  onChange,
  onContinue,
}: {
  question: Extract<QuizQuestion, { kind: "date-range" }>;
  value: { start?: string; end?: string } | undefined;
  onChange: (value: { start?: string; end?: string }) => void;
  onContinue: () => void;
}) {
  const start = value?.start ?? "";
  const end = value?.end ?? "";
  // Half-filled state — one date set, the other blank — is invalid.
  // Either both dates or neither (use the "I'm flexible" skip).
  // Customers were hitting Continue with just the depart filled and
  // ending up with one-night trips, so block it explicitly.
  const halfFilled = (Boolean(start) && !end) || (!start && Boolean(end));
  const endBeforeStart = Boolean(start) && Boolean(end) && end < start;
  const invalid = halfFilled || endBeforeStart;
  return (
    <div className="max-w-md mx-auto w-full space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs uppercase tracking-widest text-muted-foreground">
            Depart
          </span>
          <input
            type="date"
            value={start}
            onChange={(e) =>
              onChange({ start: e.target.value || undefined, end: end || undefined })
            }
            className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-widest text-muted-foreground">
            Return
          </span>
          <input
            type="date"
            value={end}
            onChange={(e) =>
              onChange({ start: start || undefined, end: e.target.value || undefined })
            }
            min={start || undefined}
            className="mt-1 w-full rounded-xl border border-border bg-surface-raised px-3 py-2.5 text-sm"
          />
        </label>
      </div>
      {invalid && (
        <p className="text-xs text-[hsl(var(--destructive))]">
          {endBeforeStart
            ? "Return must be on or after departure."
            : "Fill in both dates, or use \"I'm flexible — skip\" below."}
        </p>
      )}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            onChange({});
            onContinue();
          }}
          className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline transition"
        >
          I'm flexible — skip
        </button>
        <Button onClick={onContinue} size="lg" disabled={invalid}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Free text — short or long answer, optionally optional.                      */
/* -------------------------------------------------------------------------- */

export function FreeTextView({
  question,
  value,
  onChange,
  onContinue,
}: {
  question: Extract<QuizQuestion, { kind: "free-text" }>;
  value: string | undefined;
  onChange: (value: string) => void;
  onContinue: () => void;
}) {
  const v = value ?? "";
  const canContinue = question.optional || v.trim().length > 0;
  return (
    <div className="max-w-xl mx-auto w-full space-y-4">
      <textarea
        rows={3}
        autoFocus
        value={v}
        onChange={(e) => onChange(e.target.value)}
        placeholder={question.placeholder}
        className="w-full rounded-2xl border border-border bg-surface-raised px-4 py-3 text-base resize-none"
      />
      <div className="flex justify-end">
        <Button onClick={onContinue} disabled={!canContinue} size="lg">
          {question.optional && v.trim().length === 0 ? "Skip" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Number — single numeric input. Used for exact-count questions like         */
/* "How many players?" where presets are noise.                                */
/* -------------------------------------------------------------------------- */

export function NumberView({
  question,
  value,
  onChange,
  onContinue,
}: {
  question: Extract<QuizQuestion, { kind: "number" }>;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  onContinue: () => void;
}) {
  const min = question.min ?? 1;
  const max = question.max ?? 999;
  const display = value === undefined || Number.isNaN(value) ? "" : String(value);
  const valid =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;

  return (
    <div className="max-w-md mx-auto w-full space-y-4">
      <input
        type="number"
        inputMode="numeric"
        autoFocus
        value={display}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const n = parseInt(raw, 10);
          onChange(Number.isNaN(n) ? undefined : n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && valid) {
            e.preventDefault();
            onContinue();
          }
        }}
        placeholder={question.placeholder}
        className="w-full rounded-2xl border border-border bg-surface-raised px-5 py-4 text-2xl text-center font-semibold tabular-nums"
      />
      {(question.min != null || question.max != null) && (
        <p className="text-xs text-center text-muted-foreground">
          Between {min} and {max === 999 ? "no cap" : max}
        </p>
      )}
      <div className="flex justify-end">
        <Button onClick={onContinue} disabled={!valid} size="lg">
          Continue
        </Button>
      </div>
    </div>
  );
}
