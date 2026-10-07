import type Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion } from "./schema.js";

export const CORRECTION_SCHEMA_VERSION = 11;
export const CORRECTION_COMPLIANCE_SCHEMA_VERSION = 12;
export const CORRECTION_PRINCIPLES_SCHEMA_VERSION = 13;

export const CORRECTION_COMPLIANCE_DDL = `
CREATE TABLE owner_correction_violations (
    session_id_hash TEXT NOT NULL,
    human_ordinal INTEGER NOT NULL CHECK (human_ordinal >= 0),
    bundle_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    checker TEXT NOT NULL CHECK (checker IN ('tone','document_delivery','expression_policy')),
    detected_at TEXT NOT NULL,
    PRIMARY KEY (session_id_hash, human_ordinal, bundle_key, version, checker),
    FOREIGN KEY (bundle_key, version)
        REFERENCES owner_correction_versions(bundle_key, version)
);
CREATE INDEX idx_owner_correction_violations_session
    ON owner_correction_violations(session_id_hash, human_ordinal, bundle_key, version);
`;

export const CORRECTION_PRINCIPLES_DDL = `
CREATE TABLE owner_correction_principle_members (
    principle_key TEXT NOT NULL,
    member_key TEXT NOT NULL,
    attached_at TEXT NOT NULL,
    attach_source TEXT NOT NULL CHECK (attach_source IN ('cluster','later_attach')),
    PRIMARY KEY (principle_key, member_key),
    FOREIGN KEY (principle_key) REFERENCES owner_correction_bundles(bundle_key),
    FOREIGN KEY (member_key) REFERENCES owner_correction_bundles(bundle_key)
);
CREATE INDEX idx_owner_correction_principle_members_member
    ON owner_correction_principle_members(member_key, principle_key);

CREATE TABLE owner_correction_compliance_checks (
    session_id_hash TEXT NOT NULL,
    human_ordinal INTEGER NOT NULL CHECK (human_ordinal >= 0),
    bundle_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    checker TEXT NOT NULL CHECK (checker IN ('tone','document_delivery','expression_policy')),
    is_compliant INTEGER NOT NULL CHECK (is_compliant IN (0,1)),
    checked_at TEXT NOT NULL,
    PRIMARY KEY (session_id_hash, human_ordinal, bundle_key, version, checker),
    FOREIGN KEY (bundle_key, version)
        REFERENCES owner_correction_versions(bundle_key, version)
);

CREATE TABLE owner_correction_strength_events (
    bundle_key TEXT NOT NULL,
    at TEXT NOT NULL,
    from_intensity INTEGER NOT NULL CHECK (from_intensity BETWEEN 1 AND 5),
    to_intensity INTEGER NOT NULL CHECK (to_intensity BETWEEN 1 AND 5),
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('failure','idle','graduation_revoke','manual')),
    basis TEXT NOT NULL,
    PRIMARY KEY (bundle_key, at, reason),
    FOREIGN KEY (bundle_key) REFERENCES owner_correction_bundles(bundle_key)
);

CREATE TABLE owner_correction_graduations (
    bundle_key TEXT NOT NULL,
    graduated_at TEXT NOT NULL,
    proposal_hash TEXT NOT NULL,
    revoked_at TEXT,
    revoke_reason TEXT,
    PRIMARY KEY (bundle_key, graduated_at),
    FOREIGN KEY (bundle_key) REFERENCES owner_correction_bundles(bundle_key)
);

CREATE TABLE owner_correction_abstraction_runs (
    run_id TEXT PRIMARY KEY,
    ran_at TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('shadow','on')),
    calls INTEGER NOT NULL CHECK (calls >= 0),
    groups INTEGER NOT NULL CHECK (groups >= 0),
    adopted INTEGER NOT NULL CHECK (adopted >= 0),
    rejected_guard INTEGER NOT NULL CHECK (rejected_guard >= 0),
    rejected_none INTEGER NOT NULL CHECK (rejected_none >= 0),
    skipped_reason TEXT,
    quota_before_pct REAL CHECK (quota_before_pct BETWEEN 0 AND 100),
    quota_after_pct REAL CHECK (quota_after_pct BETWEEN 0 AND 100)
);
`;

export const CORRECTION_PRINCIPLES_TABLE_NAMES = [
  "owner_correction_principle_members",
  "owner_correction_compliance_checks",
  "owner_correction_strength_events",
  "owner_correction_graduations",
  "owner_correction_abstraction_runs",
] as const;

export const CORRECTION_SCHEMA_DDL = `
CREATE TABLE owner_correction_events (
    event_id TEXT PRIMARY KEY,
    session_id_hash TEXT NOT NULL,
    source_uuid_hash TEXT,
    human_ordinal INTEGER NOT NULL CHECK (human_ordinal > 0),
    observed_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('user','queued_command','hook','legacy_import')),
    excerpt TEXT NOT NULL CHECK (length(excerpt) <= 120),
    previous_action TEXT NOT NULL CHECK (length(previous_action) <= 160),
    action_first_locator_hash TEXT,
    action_last_locator_hash TEXT,
    project TEXT NOT NULL,
    scope TEXT NOT NULL,
    raw_text_hash TEXT NOT NULL,
    source_locator_hash TEXT NOT NULL,
    processed_at TEXT NOT NULL
);

CREATE TABLE owner_correction_evidence (
    event_id TEXT NOT NULL,
    bundle_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('utterance_detection','request_repeat','legacy_import')),
    score INTEGER NOT NULL,
    detector_version TEXT NOT NULL,
    conditions TEXT NOT NULL,
    polarity TEXT NOT NULL,
    PRIMARY KEY (event_id, bundle_key),
    FOREIGN KEY (event_id) REFERENCES owner_correction_events(event_id),
    FOREIGN KEY (bundle_key) REFERENCES owner_correction_bundles(bundle_key)
);

CREATE TRIGGER owner_correction_evidence_max_three_insert
BEFORE INSERT ON owner_correction_evidence
WHEN (SELECT COUNT(*) FROM owner_correction_evidence WHERE event_id = NEW.event_id) >= 3
BEGIN
    SELECT RAISE(ABORT, 'owner correction event evidence limit exceeded');
END;

CREATE TRIGGER owner_correction_evidence_max_three_update
BEFORE UPDATE OF event_id, bundle_key ON owner_correction_evidence
WHEN (
    SELECT COUNT(*)
    FROM owner_correction_evidence
    WHERE event_id = NEW.event_id
      AND NOT (event_id = OLD.event_id AND bundle_key = OLD.bundle_key)
) >= 3
BEGIN
    SELECT RAISE(ABORT, 'owner correction event evidence limit exceeded');
END;

CREATE TABLE owner_correction_pending (
    receipt_id TEXT PRIMARY KEY,
    session_id_hash TEXT NOT NULL,
    received_at TEXT NOT NULL,
    last_confirmed_ordinal INTEGER NOT NULL CHECK (last_confirmed_ordinal >= 0),
    raw_text_hash TEXT NOT NULL,
    extracted_candidates TEXT NOT NULL,
    action_first_locator_hash TEXT,
    action_last_locator_hash TEXT,
    matched_event_id TEXT,
    output_epoch INTEGER,
    output_order INTEGER,
    output_bundle_key TEXT,
    output_version INTEGER,
    output_hash TEXT,
    output_callback_succeeded_at TEXT,
    FOREIGN KEY (matched_event_id) REFERENCES owner_correction_events(event_id),
    FOREIGN KEY (output_bundle_key, output_version)
        REFERENCES owner_correction_versions(bundle_key, version)
);

CREATE TABLE owner_correction_bundles (
    bundle_key TEXT PRIMARY KEY,
    memory_id TEXT UNIQUE,
    rule_text TEXT NOT NULL CHECK (length(rule_text) <= 240),
    topic_key TEXT NOT NULL,
    polarity TEXT NOT NULL,
    condition_key TEXT NOT NULL,
    project TEXT NOT NULL,
    scope TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('project','owner')),
    status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','expired','rejected','disputed')),
    intensity INTEGER NOT NULL CHECK (intensity BETWEEN 1 AND 5),
    occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 0),
    session_count INTEGER NOT NULL CHECK (session_count >= 0),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT,
    lifetime_kind TEXT NOT NULL CHECK (lifetime_kind IN ('explicit_continuing','inferred','task','routing')),
    continuation_basis TEXT NOT NULL,
    confirmed_at TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    counterevidence_event_id TEXT,
    last_confirmation_asked_at TEXT,
    confirmation_state TEXT NOT NULL CHECK (confirmation_state IN ('none','offered','answered')),
    FOREIGN KEY (memory_id) REFERENCES memories(id),
    FOREIGN KEY (counterevidence_event_id) REFERENCES owner_correction_events(event_id)
);

CREATE TABLE owner_correction_versions (
    bundle_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    rule_text TEXT NOT NULL CHECK (length(rule_text) <= 240),
    body_hash TEXT NOT NULL,
    conditions TEXT NOT NULL,
    condition_key TEXT NOT NULL,
    polarity TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('project','owner')),
    status TEXT NOT NULL CHECK (status IN ('candidate','confirmed','expired','rejected','disputed')),
    confirmed_at TEXT,
    expires_at TEXT,
    lifetime_kind TEXT NOT NULL CHECK (lifetime_kind IN ('explicit_continuing','inferred','task','routing')),
    continuation_basis TEXT NOT NULL,
    evidence_event_ids TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    change_reason TEXT NOT NULL,
    PRIMARY KEY (bundle_key, version),
    FOREIGN KEY (bundle_key) REFERENCES owner_correction_bundles(bundle_key)
);

CREATE TABLE owner_correction_sessions (
    session_id_hash TEXT PRIMARY KEY,
    human_ordinal INTEGER NOT NULL CHECK (human_ordinal >= 0),
    transcript_offset INTEGER NOT NULL CHECK (transcript_offset >= 0),
    transcript_identity TEXT NOT NULL,
    compact_epoch INTEGER NOT NULL CHECK (compact_epoch >= 0),
    last_refresh_ordinal INTEGER NOT NULL CHECK (last_refresh_ordinal >= 0),
    last_seen_at TEXT NOT NULL
);

CREATE TABLE owner_correction_injections (
    session_id_hash TEXT NOT NULL,
    compact_epoch INTEGER NOT NULL CHECK (compact_epoch >= 0),
    bundle_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    human_ordinal INTEGER NOT NULL CHECK (human_ordinal >= 0),
    trigger TEXT NOT NULL CHECK (trigger IN ('start','prompt','refresh','compact')),
    emitted_at TEXT NOT NULL,
    output_order INTEGER NOT NULL CHECK (output_order >= 0),
    body_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
    body_included INTEGER NOT NULL CHECK (body_included IN (0,1)),
    stdout_status TEXT NOT NULL CHECK (stdout_status IN ('emitted','failed')),
    UNIQUE (session_id_hash, compact_epoch, bundle_key, version, human_ordinal, trigger),
    FOREIGN KEY (bundle_key, version)
        REFERENCES owner_correction_versions(bundle_key, version)
);

CREATE TABLE owner_correction_imports (
    source_store_hash TEXT NOT NULL,
    source_memory_id TEXT NOT NULL,
    target_memory_id TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    source_timestamp TEXT NOT NULL,
    source_content_hash TEXT NOT NULL,
    UNIQUE (source_store_hash, source_memory_id),
    FOREIGN KEY (target_memory_id) REFERENCES memories(id)
);
`;

export const CORRECTION_TABLE_NAMES = [
  "owner_correction_events",
  "owner_correction_evidence",
  "owner_correction_pending",
  "owner_correction_bundles",
  "owner_correction_versions",
  "owner_correction_sessions",
  "owner_correction_injections",
  "owner_correction_imports",
];

function correctionTablesExist(db: Database.Database): boolean {
  const placeholders = CORRECTION_TABLE_NAMES.map(() => "?").join(", ");
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (" + placeholders + ")",
  ).get(...CORRECTION_TABLE_NAMES) as { count: number };
  return row.count === CORRECTION_TABLE_NAMES.length;
}

export function initializeCorrectionSchema(db: Database.Database): void {
  const schemaVersion = getSchemaVersion(db);
  if (schemaVersion >= CORRECTION_SCHEMA_VERSION) {
    if (!correctionTablesExist(db)) {
      throw new Error("schema version 11 is missing owner correction tables");
    }
    return;
  }

  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error("owner correction schema requires schema version " + CURRENT_SCHEMA_VERSION);
  }

  db.pragma("foreign_keys = ON");
  const transaction = db.transaction(() => {
    db.exec(CORRECTION_SCHEMA_DDL);
    db.prepare(
      "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
    ).run(CORRECTION_SCHEMA_VERSION);
  });
  transaction();
}
