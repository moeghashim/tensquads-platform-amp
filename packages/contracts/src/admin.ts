import { z } from "zod";

// The admin commands to the Platform object (ARCHITECTURE section 6.2).
// Only a super admin can send them.

const id = z.string().min(1);

const base = {
	commandId: id,
	at: z.iso.datetime(),
};

const createAccount = z
	.object({
		...base,
		type: z.literal("CreateAccount"),
		name: z.string().min(1),
		// An IANA time zone, for example Asia/Riyadh.
		timeZone: z.string().min(1),
		language: z.enum(["en", "ar"]),
		modelProfile: z.enum(["real", "test"]),
		initialCredits: z.int().nonnegative().optional(),
	})
	.strict();

const addOwner = z
	.object({
		...base,
		type: z.literal("AddOwner"),
		accountId: id,
		identityRef: id,
	})
	.strict();

// The price is in millionths of a US dollar for one unit.
const setUnitPrice = z
	.object({
		...base,
		type: z.literal("SetUnitPrice"),
		provider: id,
		// The model is empty for a price with no model, for example the seconds of the sandbox.
		model: z.string(),
		unit: id,
		price: z.int().nonnegative(),
		startsAt: z.iso.datetime(),
	})
	.strict();

// A period is one UTC month, for example 2026-11.
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a UTC month like 2026-11.");

// The amount is in millionths of a US dollar.
const setSharedCost = z
	.object({
		...base,
		type: z.literal("SetSharedCost"),
		period,
		kind: z.enum(["storage", "database", "worker"]),
		provider: id,
		amount: z.int().nonnegative(),
		supersedes: id.optional(),
	})
	.strict();

export const adminCommand = z.discriminatedUnion("type", [createAccount, addOwner, setUnitPrice, setSharedCost]);

export type AdminCommand = z.infer<typeof adminCommand>;
