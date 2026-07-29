/**
 * Negative type-level test for the carrier `block_id` brand (mirroring
 * `format-money.type-test.ts`, and checked by `pnpm typecheck` rather than
 * vitest: every `@ts-expect-error` must be triggered, so if the brand stops
 * being enforced the suppressed error vanishes, tsc reports the unused directive,
 * and typecheck fails).
 *
 * THE RULE IT PINS. Only `form` and `table` echo `block_id` back to the plugin
 * (verified in the installed 0.31.1 renderer: `blocks/form.tsx` on `form_submit`,
 * `blocks/table.tsx` twice on `block_action` — three sites, no others). A button —
 * including a `section` accessory and an `empty` block's actions — carries context
 * in `value` and echoes NO `block_id`. Since every delete, status transition and
 * drill-in is a button, a carrier token on an `actions`/`empty`/`section` block
 * would read back as `undefined` at runtime, on a money path, with no error. So it
 * must not compile.
 */
import { encodeCarrier } from "../src/admin/scaffold/carrier.js";
import type {
	ActionsBlock,
	EmptyBlock,
	FormBlock,
	SectionBlock,
	TableBlock,
} from "../src/types.js";

const carrier = encodeCarrier("orders:refund", { orderId: "ord-1" });

// -- the two blocks that DO echo `block_id` accept a carrier --------------------

const form: FormBlock = {
	type: "form",
	block_id: carrier,
	fields: [],
	submit: { label: "Refund", action_id: "orders:refund" },
};

const table: TableBlock = {
	type: "table",
	block_id: carrier,
	columns: [],
	rows: [],
};

// ...and still accept a plain string key.
const plainForm: FormBlock = {
	type: "form",
	block_id: "orders:filter",
	fields: [],
	submit: { label: "Apply", action_id: "orders:apply-filter" },
};

// -- every other block REJECTS a carrier ---------------------------------------

// @ts-expect-error — an `actions` block never echoes `block_id`; a button's only
// context channel is `ButtonElement.value`.
const actions: ActionsBlock = { type: "actions", block_id: carrier, elements: [] };

// @ts-expect-error — an `empty` block's actions are bare elements; no echo.
const empty: EmptyBlock = { type: "empty", block_id: carrier, title: "None" };

// @ts-expect-error — a `section` accessory is a bare element; no echo.
const section: SectionBlock = { type: "section", block_id: carrier, text: "Filters" };

// ...but a plain React key is fine on all of them.
const keyedActions: ActionsBlock = { type: "actions", block_id: "orders:row-1", elements: [] };
const keyedEmpty: EmptyBlock = { type: "empty", block_id: "orders:empty", title: "None" };
const keyedSection: SectionBlock = { type: "section", block_id: "orders:filters", text: "F" };

// -- the brand is phantom: a carrier is still an ordinary string ----------------

const asString: string = carrier;
const length: number = carrier.length;

export {
	actions,
	asString,
	empty,
	form,
	keyedActions,
	keyedEmpty,
	keyedSection,
	length,
	plainForm,
	section,
	table,
};
