import { createClient } from "lakebed/client";
import type app from "../server/index";

export const client = createClient<typeof app>();

export type Group = NonNullable<ReturnType<typeof client.useQuery<"group">>>;
export type Card = Group["pending"][number];
export type Detail = NonNullable<ReturnType<typeof client.useQuery<"receipt">>>;
export type Profile = NonNullable<ReturnType<typeof client.useQuery<"profile">>>;
export type StandingRow = Group["standings"][number];
