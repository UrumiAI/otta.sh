/**
 * The day document's stored shapes — the flat guarded shape every live write
 * produces, and the LEGACY nested one existing stores still hold — on **D1**, the
 * dialect Otta ships on. The migration forward rides the host's guarded numeric
 * delta and its SQLite JSON functions, which `better-sqlite3` only approximates.
 * The cases are shared with the Node tiers (`reporting-stored-shape-cases.ts`).
 */
import { REPORTING_LAYOUT } from "../reporting-collections.js";
import { reportingStoredShapeCases } from "../reporting-stored-shape-cases.js";
import { useD1Storage } from "./describe-d1.js";

reportingStoredShapeCases(useD1Storage(REPORTING_LAYOUT));
