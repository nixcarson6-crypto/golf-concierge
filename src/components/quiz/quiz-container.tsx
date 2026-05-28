"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  GOLF_QUIZ,
  QUIZ_SECTIONS,
  type QuizQuestion,
  type QuizAnswers,
} from "@/lib/quiz/golf-questions";
import {
  SingleSelectView,
  MultiSelectView,
  SliderView,
  DateRangeView,
  FreeTextView,
  NumberView,
} from "./quiz-question-views";
import { QuizLoading } from "./quiz-loading";

/**
 * The Hungry Root-style quiz. Walks the user through every constraint
 * we need to plan a trip, then submits all answers to /build in one
 * shot for a single AI generation pass (much cheaper than chat).
 */
export function QuizContainer({ tripId }: { tripId: string }) {
  const router = useRouter();
  // Persist answers + step to localStorage so a refresh / accidental
  // back-button / browser crash mid-build doesn't wipe the customer's
  // progress. Keyed by tripId so multiple drafts in flight don't collide.
  //
  // IMPORTANT: we DON'T hydrate inside the useState initializer.  That
  // would diverge from the server-rendered HTML (which has no
  // localStorage) and trigger a React hydration mismatch — Next surfaces
  // it as a red error overlay AND regenerates the entire tree on the
  // client, which flashed the user back to step 0. Instead we mount with
  // defaults, then a useEffect rehydrates from localStorage after first
  // paint.  We gate the actual quiz UI behind a `hydrated` flag so the
  // user never sees that one-frame flash.
  const storageKey = `pyltrix.quiz.${tripId}`;
  const [answers, setAnswers] = React.useState<QuizAnswers>({});
  const [stepIdx, setStepIdx] = React.useState<number>(0);
  const [hydrated, setHydrated] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Load any previously-saved progress from localStorage AFTER mount.
  // Runs once per mount; safe to read window here.
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          answers?: QuizAnswers;
          stepIdx?: number;
        };
        if (parsed.answers && typeof parsed.answers === "object") {
          setAnswers(parsed.answers);
        }
        if (typeof parsed.stepIdx === "number" && parsed.stepIdx >= 0) {
          setStepIdx(parsed.stepIdx);
        }
      }
    } catch {
      // Corrupt JSON / blocked storage / SecurityError in private mode.
      // Ignore and start fresh — better than crashing the whole quiz.
    }
    setHydrated(true);
  }, [storageKey]);

  // Mirror state to localStorage on every change AFTER hydration. We
  // skip the very first render because that would overwrite a saved
  // payload with the default empty {} before we've had a chance to
  // load it.
  React.useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ answers, stepIdx }),
      );
    } catch {
      // Storage might be full / blocked by the browser — ignore, the
      // worst case is the user loses their place on a crash. The build
      // itself still works because answers live in component state.
    }
  }, [hydrated, answers, stepIdx, storageKey]);

  // Filter questions whose `shouldShow` predicate fails for the current
  // answer set. We re-evaluate on every render so branching is live.
  const visibleQuestions = React.useMemo(() => {
    return GOLF_QUIZ.filter((q) => !q.shouldShow || q.shouldShow(answers));
  }, [answers]);

  // Clamp the step into the visible range — if a branch caused the
  // current question to disappear, snap forward.
  const currentStep = Math.min(stepIdx, visibleQuestions.length - 1);
  const currentQuestion: QuizQuestion | undefined = visibleQuestions[currentStep];

  const isLast = currentStep === visibleQuestions.length - 1;
  const total = visibleQuestions.length;
  const progressPct = ((currentStep + 1) / (total + 1)) * 100; // +1 for the "generating" final step

  const goBack = () => {
    if (currentStep === 0) {
      router.push("/dashboard");
      return;
    }
    setStepIdx((s) => Math.max(0, s - 1));
  };

  const setAnswer = (id: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };

  const advance = React.useCallback(() => {
    if (isLast) {
      void submit();
      return;
    }
    setStepIdx((s) => s + 1);
  }, [isLast]);

  const submit = async () => {
    setSubmitting(true);
    // 4-minute client-side hard ceiling. Server-side maxDuration is 5
    // minutes; staying under that lets the abort fire before Vercel
    // would and gives us a clean, user-facing message instead of a
    // platform-level 504 with no JSON body.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    try {
      const res = await fetch(`/api/trips/${tripId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Server returns { error: "..." } JSON on failures. Surface that
        // exact message to the user instead of a bare "Build failed: 500".
        const txt = await res.text().catch(() => "");
        let friendly = `Build failed (${res.status})`;
        try {
          const json = JSON.parse(txt) as { error?: string };
          if (json.error) friendly = json.error;
        } catch {
          if (txt) friendly = txt.slice(0, 240);
        }
        throw new Error(friendly);
      }
      // Land on the trip workspace with autoBook=1 so the booking modal
      // auto-opens for the best-fit flight (one-click confirm if the
      // user has a saved traveler profile). The user just told us
      // everything they wanted — don't make them click a Book button
      // they already implied.
      //
      // Clear the persisted quiz state — the trip is built, the answers
      // live on the trip row now, no reason to keep replaying them.
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // Ignore — non-fatal.
      }
      router.push(`/trips/${tripId}?autoBook=1`);
      router.refresh();
    } catch (err) {
      console.error("[quiz submit]", err);
      const wasAborted =
        err instanceof DOMException && err.name === "AbortError";
      const message = wasAborted
        ? "Your trip is taking longer than usual. We saved your details — open it from your dashboard to retry."
        : err instanceof Error
          ? err.message
          : "Couldn't build your trip — try again.";
      toast.error(message);
      // The trip row was already saved at the start of /build with the
      // user's constraints, so route them to the trip workspace instead
      // of leaving them stranded in the quiz UI. The result page picks
      // up `?buildError=...` and shows a "Build failed — edit & retry"
      // banner that links back to /build/[id]. We KEEP the localStorage
      // entry intact so when they click "edit your answers" the quiz
      // hydrates from where they left off — no re-entering 16 answers.
      router.push(
        `/trips/${tripId}?buildError=${encodeURIComponent(message)}`,
      );
      router.refresh();
    } finally {
      clearTimeout(abortTimer);
    }
  };

  if (submitting) {
    return <QuizLoading tripId={tripId} />;
  }

  if (!currentQuestion) {
    return null;
  }

  // Section progress chips (light up as the user advances into each section)
  const sectionState = QUIZ_SECTIONS.map((section) => {
    const firstIdx = visibleQuestions.findIndex(
      (q) => q.sectionId === section.id,
    );
    const lastIdx =
      visibleQuestions.length -
      1 -
      [...visibleQuestions].reverse().findIndex((q) => q.sectionId === section.id);
    const reached = firstIdx !== -1 && currentStep >= firstIdx;
    const done = lastIdx !== -1 && currentStep > lastIdx;
    return { ...section, reached, done };
  });

  return (
    <div className="min-h-dvh bg-concierge-radial flex flex-col">
      {/* Top bar: back + progress + section chips */}
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b border-border/40 backdrop-blur-sm bg-background/80 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <button
              type="button"
              onClick={goBack}
              className="size-9 rounded-full grid place-items-center hover:bg-surface-raised transition"
              aria-label="Back"
            >
              <ArrowLeft className="size-4" />
            </button>
            <div className="flex-1 h-1.5 rounded-full bg-surface-raised overflow-hidden">
              <div
                className="h-full bg-[hsl(var(--copper))] transition-all duration-300 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-xs tabular-nums text-muted-foreground w-16 text-right">
              {currentStep + 1} / {total}
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 text-[11px] uppercase tracking-widest pl-12">
            {sectionState.map((s) => (
              <span
                key={s.id}
                className={cn(
                  "transition",
                  s.done
                    ? "text-[hsl(var(--copper))]"
                    : s.reached
                      ? "text-foreground font-medium"
                      : "text-muted-foreground/50",
                )}
              >
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Question */}
      <div className="flex-1 flex flex-col justify-center px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-3xl mx-auto w-full space-y-8">
          <header className="space-y-2 text-center">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              {currentQuestion.title}
            </h1>
            {currentQuestion.subtitle && (
              <p className="text-base text-muted-foreground max-w-xl mx-auto">
                {currentQuestion.subtitle}
              </p>
            )}
          </header>

          {currentQuestion.kind === "single-select" && (
            <SingleSelectView
              question={currentQuestion}
              value={answers[currentQuestion.id] as string | undefined}
              freeText={
                currentQuestion.freeTextField
                  ? (answers[currentQuestion.freeTextField.writesTo] as
                      | string
                      | undefined)
                  : undefined
              }
              onAnswer={(v) => {
                setAnswer(currentQuestion.id, v);
                // Picking an option clears any half-typed free-text input
                // so the resulting answer is unambiguous.
                if (currentQuestion.freeTextField) {
                  setAnswer(currentQuestion.freeTextField.writesTo, "");
                }
                // Auto-advance on single-select (Hungry Root pattern). Give
                // the selected-state animation a beat to land first.
                setTimeout(() => advance(), 180);
              }}
              onFreeTextChange={(v) => {
                if (!currentQuestion.freeTextField) return;
                setAnswer(currentQuestion.freeTextField.writesTo, v);
              }}
              onFreeTextSubmit={() => {
                if (!currentQuestion.freeTextField) return;
                // Filling the free-text input acts as picking the
                // declared option — keeps downstream branching simple.
                setAnswer(currentQuestion.id, currentQuestion.freeTextField.selectsValue);
                advance();
              }}
            />
          )}

          {currentQuestion.kind === "multi-select" && (
            <MultiSelectView
              question={currentQuestion}
              value={answers[currentQuestion.id] as string[] | undefined}
              freeText={
                currentQuestion.freeTextField
                  ? (answers[currentQuestion.freeTextField.writesTo] as
                      | string
                      | undefined)
                  : undefined
              }
              onChange={(v) => setAnswer(currentQuestion.id, v)}
              onFreeTextChange={(v) => {
                if (!currentQuestion.freeTextField) return;
                setAnswer(currentQuestion.freeTextField.writesTo, v);
              }}
              onContinue={advance}
            />
          )}

          {currentQuestion.kind === "slider" && (
            <SliderView
              question={currentQuestion}
              value={answers[currentQuestion.id] as number | undefined}
              onChange={(v) => setAnswer(currentQuestion.id, v)}
              onContinue={advance}
            />
          )}

          {currentQuestion.kind === "date-range" && (
            <DateRangeView
              question={currentQuestion}
              value={
                answers[currentQuestion.id] as
                  | { start?: string; end?: string }
                  | undefined
              }
              onChange={(v) => setAnswer(currentQuestion.id, v)}
              onContinue={advance}
            />
          )}

          {currentQuestion.kind === "free-text" && (
            <FreeTextView
              question={currentQuestion}
              value={answers[currentQuestion.id] as string | undefined}
              onChange={(v) => setAnswer(currentQuestion.id, v)}
              onContinue={advance}
            />
          )}

          {currentQuestion.kind === "number" && (
            <NumberView
              question={currentQuestion}
              value={answers[currentQuestion.id] as number | undefined}
              onChange={(v) => setAnswer(currentQuestion.id, v)}
              onContinue={advance}
            />
          )}
        </div>
      </div>
    </div>
  );
}
