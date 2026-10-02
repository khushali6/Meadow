import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { redact } from "../meadow/core/redact";

export type TrpcContext = Record<string, never>;

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  isDev: false,
  errorFormatter({ shape }) {
    return { ...shape, message: redact(shape.message), data: { ...shape.data, stack: undefined } };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
