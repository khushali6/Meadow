import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { COOKIE_NAME } from "@shared/const";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { addNote, controlRun, createProject, decideApproval, snapshot, startRun, updateSettings, validatePlan } from "./meadow";

const settingsSchema = z.object({
  notificationLevel: z.enum(["all", "phases", "failures"]).optional(),
  screenshotEnabled: z.boolean().optional(),
  previewUrl: z.string().optional(),
  budget: z.number().min(100).max(100000).optional(),
  quietHours: z.boolean().optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  meadow: router({
    snapshot: publicProcedure.query(() => snapshot()),
    createProject: publicProcedure.input(z.object({ name: z.string().min(2), engine: z.string().min(1), description: z.string().optional() })).mutation(({ input }) => createProject(input)),
    startRun: publicProcedure.input(z.object({ projectId: z.string() })).mutation(({ input }) => startRun(input.projectId)),
    controlRun: publicProcedure.input(z.object({ runId: z.string(), action: z.enum(["pause", "resume", "stop", "retry", "rollback"]) })).mutation(({ input }) => controlRun(input.runId, input.action)),
    decideApproval: publicProcedure.input(z.object({ id: z.string(), decision: z.enum(["approved", "denied"]) })).mutation(({ input }) => decideApproval(input.id, input.decision)),
    addNote: publicProcedure.input(z.object({ title: z.string().min(2), body: z.string().min(2) })).mutation(({ input }) => addNote(input)),
    updateSettings: publicProcedure.input(settingsSchema).mutation(({ input }) => updateSettings(input)),
    validatePlan: publicProcedure.input(z.object({ markdown: z.string() })).mutation(({ input }) => validatePlan(input.markdown)),
    doctor: publicProcedure.query(() => ({ checkedAt: new Date().toISOString(), engines: [{ name: "Cursor CLI", state: "ready", detail: "Adapter configured · local binary detected by the daemon" }, { name: "Claude Code", state: "optional", detail: "Optional adapter · connect an existing subscription" }, { name: "Gemini CLI", state: "optional", detail: "Free tier adapter · not configured" }, { name: "OpenCode", state: "optional", detail: "Community adapter · not configured" }] })),
  }),
});

export type AppRouter = typeof appRouter;
