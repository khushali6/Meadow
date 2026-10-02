import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

type Out = inferRouterOutputs<AppRouter>;

export type Overview = Out["overview"];
export type ProjectSummary = Overview["projects"][number];
export type Approval = Overview["approvals"][number];
export type ProjectDetail = Out["project"];
export type Phase = ProjectDetail["phases"][number];
export type Execution = NonNullable<ProjectDetail["execution"]>;
export type Event = ProjectDetail["events"][number];
export type Settings = Out["settings"];
export type Doctor = Out["doctor"];
export type ChatReply = Out["chat"];
