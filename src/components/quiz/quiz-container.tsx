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

  // Live refs so a DELAYED advance() (the ~180ms auto-advance fired after a
  // single-select tap) reads the CURRENT visible-question count + submit, NOT a
  // stale closure from the render the tap happened in. Tapping an option can
  // add/remove later questions (changing which step is last), so an old closure
  // could submit one question early or silently skip one. Reading via refs +
  // a functional setStepIdx makes any captured advance() instance correct.
  const visibleCountRef = React.useRef(visibleQuestions.length);
  visibleCountRef.current = visibleQuestions.length;
  const submitRef = React.useRef<() => void>(() => {});

  const goBack = () => {
    // Step-0 Back = leave the quiz. Go to the trips LIST, not /dashboard —
    // /dashboard auto-redirects to the most recent draft (this same quiz),
    // which trapped first-time users in a back-button loop.
    if (currentStep === 0) {
      router.push("/trips");
      return;
    }
    setStepIdx((s) => Math.max(0, s - 1));
  };

  const setAnswer = (id: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  };

  const advance = React.useCallback(() => {
    setStepIdx((s) => {
      // Last visible step? submit. Read the LIVE count via ref so a delayed
      // call can't act on a stale "isLast".
      if (s >= visibleCountRef.current - 1) {
        void submitRef.current();
        return s;
      }
      return s + 1;
    });
  }, []);

  const submit = async () => {
    setSubmitting(true);
    // 6-minute client-side ceiling — comfortably above the server's
    // maxDuration (300s) so the SERVER decides the real cap; this only stops
    // the browser hanging forever if the response is lost. Big multi-leg trips
    // legitimately need a few minutes, so we stay generous: a premature abort
    // is more user-hostile than a long spinner with live progress text. If we
    // do abort, the catch below polls /progress to recover a build that
    // actually finished server-side before the browser gave up.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 6 * 60 * 1000);
    // One silent auto-retry on transient server failures (502, network
    // blip) before we dump the customer to the error banner. Most
    // 'we couldn't finish your itinerary' failures are model-tier
    // hiccups that resolve on the second try — surfacing the banner
    // first then making them tap retry is just user-hostile.
    const callBuildOnce = async (): Promise<Response> =>
      fetch(`/api/trips/${tripId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
        signal: controller.signal,
      });
    try {
      let res = await callBuildOnce();
      if (!res.ok && res.status >= 500) {
        // Server returned a 5xx — try one more time before bailing.
        await new Promise((r) => setTimeout(r, 3000));
        console.warn(
          `[quiz] build returned ${res.status} — silently retrying once before showing the error.`,
        );
        res = await callBuildOnce();
      }
      if (!res.ok) {
        // Server returns { error: "..." } JSON on failures. Surface that
        // exact message to the user instead of a bare "Build failed: 500".
        const txt = await res.text().catch(() => "");
        let friendly = `Build failed (${res.status})`;
        try {
          const json = JSON.parse(txt) as { error?: string };
          if (json.error) friendly = json.error;
        } catch {
          // NOT our JSON — likely a platform HTML error page (a 504 gateway
          // timeout renders an HTML body). Never slice raw HTML into the
          // banner; use a clean, honest message instead.
          const looksHtml = /^\s*<|<html|<!doctype/i.test(txt);
          if (res.status === 504 || res.status === 502 || looksHtml) {
            friendly =
              "This took longer than expected and timed out. Please try again — it usually works on the second attempt.";
          } else if (txt) {
            friendly = txt.slice(0, 240);
          }
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
      // Full-page navigation instead of router.push + router.refresh —
      // refresh re-renders the CURRENT route (/build/[id]) which can
      // race the push and remount QuizContainer in fresh state, briefly
      // showing the quiz back at step 1. window.location.assign forces
      // a clean navigation that can't race.
      window.location.assign(`/trips/${tripId}?autoBook=1`);
    } catch (err) {
      console.error("[quiz submit]", err);
      const wasAborted =
        err instanceof DOMException && err.name === "AbortError";
      // NETWORK-DROP RECOVERY: a "Failed to fetch" here usually means the
      // customer's connection dropped while waiting on the long build
      // response — but the build KEEPS RUNNING server-side (a real case:
      // build returned 200 in 183s while the browser had already given
      // up). Instead of declaring failure, switch to polling the
      // ultra-light /progress endpoint; the moment the itinerary exists,
      // land on the trip like nothing happened. Only show the error if
      // the build genuinely never finishes.
      const wasNetworkDrop =
        !wasAborted &&
        (err instanceof TypeError ||
          (err instanceof Error && /failed to fetch|networkerror|load failed/i.test(err.message)));
      // Recover a build that finished server-side even though the browser gave
      // up — a dropped connection OR our own 6-min abort. Poll /progress; the
      // moment the itinerary exists, land on the trip. Abort gets a short
      // window (the server's 300s cap already settled the outcome); a network
      // drop gets longer in case the user is still reconnecting.
      const shouldRecover = wasNetworkDrop || wasAborted;
      if (shouldRecover) {
        toast.message(
          wasAborted
            ? "Almost there — checking on your trip…"
            : "Connection hiccup — your trip is still being built. Hang tight…",
        );
        const recovered = await (async (): Promise<boolean> => {
          const deadline = Date.now() + (wasAborted ? 45_000 : 6 * 60 * 1000);
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5000));
            try {
              const r = await fetch(`/api/trips/${tripId}/progress`, {
                cache: "no-store",
              });
              if (!r.ok) continue;
              const j = (await r.json()) as {
                hasItinerary?: boolean;
                agentStatus?: string;
              };
              if (j.hasItinerary) return true;
              if (j.agentStatus === "FAILED") return false;
            } catch {
              // Still offline — keep trying until the deadline.
            }
          }
          return false;
        })();
        if (recovered) {
          try {
            window.localStorage.removeItem(storageKey);
          } catch {}
          window.location.assign(`/trips/${tripId}?autoBook=1`);
          return;
        }
      }
      const message = wasAborted
        ? "Your trip is taking longer than usual. We saved your details — open it from your dashboard to retry."
        : wasNetworkDrop
          ? "We lost the connection while building. Your answers are saved — check your connection and retry."
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
      //
      // Full-page navigation again so we can't race a router.refresh
      // remount of the quiz back at step 1 (which is the exact
      // "5-minute build then dumps me back to the quiz" complaint).
      window.location.assign(
        `/trips/${tripId}?buildError=${encodeURIComponent(message)}`,
      );
    } finally {
      clearTimeout(abortTimer);
    }
  };

  // Keep the ref pointed at the LATEST submit each render, so a delayed
  // advance() (which calls submitRef.current()) always submits with the most
  // recent answers — including the final tap that triggered it.
  submitRef.current = submit;

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
            <div className="flex-1 h-px bg-border overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300 ease-out"
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
                    ? "text-foreground font-medium"
                    : s.reached
                      ? "text-foreground/70"
                      : "text-muted-foreground/40",
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
