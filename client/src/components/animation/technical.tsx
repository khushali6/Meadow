import { animate, stagger, svg } from "animejs";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "../../hooks/useReducedMotion";

/** Small amber marker that pulses only while the agent is actually working. */
export function ActivityDot({ active, tone = "amber" }: { active: boolean; tone?: "amber" | "idle" | "error" }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current || !active || prefersReducedMotion()) return;
    const pulse = animate(ref.current, { scale: [1, 1.35], opacity: [1, 0.55], duration: 900, ease: "inOutQuad", loop: true, alternate: true });
    return () => void pulse.revert();
  }, [active]);
  return <span ref={ref} className={`activity-dot ${active ? "active" : tone}`} aria-hidden />;
}

/** Rows newer than the last seen id enter with a short stagger; the first paint staggers only the top rows. */
export function useStaggerNewRows(container: RefObject<HTMLElement | null>, ids: number[], selector = "[data-row-id]") {
  const seen = useRef<number | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root || !ids.length) return;
    const newest = Math.max(...ids);
    const previous = seen.current;
    seen.current = newest;
    if (prefersReducedMotion()) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const targets = previous === null ? rows.slice(0, 10) : rows.filter(row => Number(row.dataset.rowId) > previous);
    if (!targets.length) return;
    const entrance = animate(targets, { opacity: [0, 1], translateY: [6, 0], duration: 320, delay: stagger(previous === null ? 40 : 70), ease: "outQuad" });
    return () => void entrance.revert();
  }, [ids.length ? Math.max(...ids) : 0]);
}

/** When a phase passes, its connector line draws down to the next checkpoint. */
export function useCheckpointLines(container: RefObject<HTMLElement | null>, passedCount: number) {
  const previous = useRef<number | null>(null);
  useEffect(() => {
    const root = container.current;
    const before = previous.current;
    previous.current = passedCount;
    if (!root || before === null || passedCount <= before || prefersReducedMotion()) return;
    const lines = Array.from(root.querySelectorAll<HTMLElement>(".phase-line.filled")).slice(before, passedCount);
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".phase-node.done")).slice(before, passedCount);
    const draw = animate(lines, { scaleY: [0, 1], duration: 520, ease: "inOutQuad", delay: stagger(80) });
    const mark = animate(nodes, { scale: [0.6, 1], duration: 320, ease: "outBack(1.4)", delay: stagger(80) });
    return () => {
      draw.revert();
      mark.revert();
    };
  }, [passedCount]);
}

export type PipelineStage = { key: string; label: string; detail: string };

/**
 * Execution pipeline for the current phase. The amber progress line is drawn up to the
 * stage the harness reports and the marker travels to it; nothing moves unless state changes.
 */
export function ExecutionPipeline({ stages, current, state }: { stages: PipelineStage[]; current: number; state: "idle" | "active" | "done" | "blocked" }) {
  const progressRef = useRef<SVGLineElement>(null);
  const travelRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  const span = Math.max(1, stages.length - 1);
  const fraction = state === "done" ? 1 : Math.max(0, Math.min(1, current / span));

  useEffect(() => {
    const progress = progressRef.current;
    const travel = travelRef.current;
    if (!progress || !travel) return;
    const from = last.current;
    last.current = fraction;
    const [drawable] = svg.createDrawable(progress);
    if (prefersReducedMotion()) {
      drawable.setAttribute("draw", `0 ${fraction}`);
      travel.style.transform = `translateX(${fraction * 100}%)`;
      return;
    }
    const line = animate(drawable, { draw: [`0 ${from}`, `0 ${fraction}`], duration: 700, ease: "inOutQuad" });
    const move = animate(travel, { translateX: [`${from * 100}%`, `${fraction * 100}%`], duration: 700, ease: "inOutQuad" });
    return () => {
      line.pause();
      move.pause();
    };
  }, [fraction]);

  useEffect(() => {
    if (!ringRef.current || state !== "active" || prefersReducedMotion()) return;
    const pulse = animate(ringRef.current, { opacity: [0.8, 0], scale: [1, 2.2], duration: 1200, ease: "outQuad", loop: true });
    return () => void pulse.revert();
  }, [state, current]);

  return (
    <div className={`pipeline pipeline-${state}`} role="img" aria-label={`Phase pipeline: ${stages[Math.max(0, current)]?.label ?? "not started"} (${state})`}>
      <div className="pipeline-track">
        <svg className="pipeline-svg" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden>
          <line x1={0} y1={1} x2={100} y2={1} className="pipeline-base" vectorEffect="non-scaling-stroke" />
          <line ref={progressRef} x1={0} y1={1} x2={100} y2={1} className="pipeline-progress" vectorEffect="non-scaling-stroke" />
        </svg>
        {stages.map((stage, i) => <span key={stage.key} className={`pipeline-node ${i < current || state === "done" ? "done" : i === current ? "current" : ""}`} style={{ left: `${(i / span) * 100}%` }} />)}
        {current >= 0 ? (
          <div className="pipeline-travel" ref={travelRef} style={{ transform: `translateX(${fraction * 100}%)` }}>
            <span className="pipeline-ring" ref={ringRef} />
            <span className="pipeline-marker" />
          </div>
        ) : null}
      </div>
      <ol className="pipeline-stages" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
        {stages.map((stage, i) => (
          <li key={stage.key} className={i < current || state === "done" ? "done" : i === current ? `current ${state}` : ""}>
            <span className="pipeline-index">{String(i + 1).padStart(2, "0")}</span>
            <strong>{stage.label}</strong>
            <span className="pipeline-detail">{stage.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
