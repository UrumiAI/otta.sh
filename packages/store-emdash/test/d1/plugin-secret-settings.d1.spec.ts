/** `plugin-secret-settings-cases.ts` on **D1** — the raw `options` rows of
 *  EmDash's encrypted plugin settings (ADR-0032); only the database differs. */
import { pluginSecretSettingsCases } from "../plugin-secret-settings-cases.js";
import { useD1Storage } from "./describe-d1.js";

const d1 = useD1Storage({});
pluginSecretSettingsCases(() => d1.db);
