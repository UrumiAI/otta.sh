/** `plugin-secret-settings-cases.ts` on SQLite and Postgres — the raw `options`
 *  rows of EmDash's encrypted plugin settings (ADR-0032). */
import { describeEachDialect } from "./describe-each-dialect.js";
import { pluginSecretSettingsCases } from "./plugin-secret-settings-cases.js";

describeEachDialect("plugin secret settings at rest", ({ useStorage }) => {
	const store = useStorage({});
	pluginSecretSettingsCases(() => store.db);
});
