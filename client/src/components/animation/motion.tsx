import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export const UI_EASE = [0.22, 1, 0.36, 1] as const;
const press = { duration: 0.18, ease: UI_EASE };

/** Buttons: 1px lift on hover, slight press. Never bounces. */
export function MotionButton({ children, ...props }: HTMLMotionProps<"button">) {
  return (
    <motion.button whileHover={props.disabled ? undefined : { y: -1 }} whileTap={props.disabled ? undefined : { scale: 0.98 }} transition={press} {...props}>
      {children}
    </motion.button>
  );
}

/** Content that enters and leaves with a short fade and rise (banners, inline notices). */
export function Reveal({ show, children, className, role }: { show: boolean; children: ReactNode; className?: string; role?: string }) {
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div className={className} role={role} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease: UI_EASE }}>
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Modal with backdrop fade and a small scale/rise on the panel; exit is animated too. */
export function MotionDialog({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="dialog-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onKeyDown={event => event.key === "Escape" && onClose()}
          onMouseDown={event => event.target === event.currentTarget && onClose()}
        >
          <motion.div className="dialog-panel" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ type: "spring", stiffness: 420, damping: 34 }}>
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** Swaps a label with a short cross-fade when the underlying state changes. */
export function SwapText({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`swap-text ${className ?? ""}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={value} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: UI_EASE }}>
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Underline/indicator shared between tabs so the active marker slides to the selected tab. */
export function TabIndicator({ id }: { id: string }) {
  return <motion.span className="tab-indicator" layoutId={id} transition={{ type: "spring", stiffness: 520, damping: 40 }} />;
}

export { AnimatePresence, motion };
