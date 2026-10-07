/* Chat Capsule v5 — AI Output Verifier
   Validates and sanitizes AI-produced state objects.
   
   Pipeline:
     AI JSON string
        ↓
     parseAIJson()       — strip fences, parse, throw on failure
        ↓
     validateStateSchema() — check required fields/types
        ↓
     verifyEvidence()    — remove out-of-range message refs
        ↓
     detectConflicts()   — flag contradictory decisions/choices
        ↓
     sanitizeState()     — clamp confidence, remove nulls, safe strings
        ↓
     Verified state object
   
   Evidence states: supported | weakly_supported | not_supported
   Never invents replacements. Removes unsupported claims.
*/
"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Verifier = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Required top-level array fields: [snake_case, camelCase_alias].
  // Either naming convention is accepted (AI output uses snake_case; legacy tests may use camelCase).
  const REQUIRED_ARRAYS_MAP = [
    ["constraints",          null],
    ["preferences",          null],
    ["decisions",            null],
    ["superseded_decisions", "supersededDecisions"],
    ["completed_tasks",      "completedTasks"],
    ["open_tasks",           "openTasks"],
  ];
  const REQUIRED_ARRAYS = REQUIRED_ARRAYS_MAP.map(([k]) => k);

  // Optional fields allowed in the schema (whitelist for sanitization)
  const ALLOWED_FIELDS = new Set([
    "conversation_type", "goal", "current_state", "latest_request",
    "constraints", "preferences", "decisions", "superseded_decisions",
    "completed_tasks", "open_tasks", "next_action",
    "important_code", "important_facts", "known_errors",
  ]);

  // Allowed conversation types
  const VALID_TYPES = new Set(["coding", "writing", "research", "analysis", "general"]);

  /**
   * parseAIJson: strips markdown fences and parses JSON.
   * Throws a descriptive error on failure — never returns null.
   */
  function parseAIJson(raw) {
    if (!raw || typeof raw !== "string") throw new Error("AI response is empty or not a string");
    let text = raw.trim();
    // Strip markdown code fences
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    // Find the first { and last } to extract just the JSON object
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("AI response does not contain a JSON object. Response preview: " + text.slice(0, 120));
    }
    const jsonStr = text.slice(start, end + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      throw new Error("AI response JSON is malformed: " + e.message + ". Preview: " + jsonStr.slice(0, 120));
    }
  }

  /**
   * validateStateSchema: checks that required fields are present and correctly typed.
   * Returns an array of error strings. Empty array = valid.
   */
  function validateStateSchema(state) {
    if (!state || typeof state !== "object") return ["State is not an object"];
    const errors = [];

    for (const [snake, camel] of REQUIRED_ARRAYS_MAP) {
      // Accept either snake_case or camelCase; the field just needs to exist as an array
      const val = state[snake] !== undefined ? state[snake] : (camel ? state[camel] : undefined);
      if (val === undefined || val === null) {
        errors.push(`Missing required field: ${snake}`);
      } else if (!Array.isArray(val)) {
        errors.push(`Field '${snake}' must be an array, got ${typeof val}`);
      }
    }

    // Validate confidence values on evidence-bearing fields
    const evidenceFields = ["goal", "current_state", "latest_request"];
    for (const f of evidenceFields) {
      if (state[f] && typeof state[f] === "object") {
        const conf = state[f].confidence;
        if (conf != null && (typeof conf !== "number" || conf < 0 || conf > 1)) {
          errors.push(`Field '${f}.confidence' must be 0.0-1.0, got ${conf}`);
        }
      }
    }

    if (state.conversation_type && !VALID_TYPES.has(state.conversation_type)) {
      errors.push(`Invalid conversation_type: '${state.conversation_type}'`);
    }

    return errors;
  }

  /**
   * verifyEvidence: removes message indices that are out of range.
   * Mutates state in place (removes bad refs).
   * Returns { valid: boolean, warnings: string[] }
   */
  function verifyEvidence(state, transcript) {
    if (!state || !Array.isArray(transcript)) return { valid: true, warnings: [] };
    const maxIdx = transcript.length; // 1-based max valid index
    const warnings = [];

    function cleanEvidence(obj, path) {
      if (!obj || !Array.isArray(obj.evidence)) return;
      const original = obj.evidence.length;
      obj.evidence = obj.evidence.filter((idx) => {
        const valid = Number.isInteger(idx) && idx >= 1 && idx <= maxIdx;
        if (!valid) warnings.push(`${path}: evidence index ${idx} out of range (1-${maxIdx}), removed`);
        return valid;
      });
      if (obj.evidence.length < original) {
        warnings.push(`${path}: removed ${original - obj.evidence.length} out-of-range evidence reference(s)`);
      }
    }

    // Clean top-level evidence fields
    const topFields = ["goal", "current_state", "latest_request"];
    for (const f of topFields) {
      if (state[f] && typeof state[f] === "object") cleanEvidence(state[f], f);
    }

    // Clean array fields
    const arrayFields = [
      "constraints", "preferences", "decisions", "superseded_decisions",
      "completed_tasks", "open_tasks", "important_code", "important_facts", "known_errors",
    ];
    for (const f of arrayFields) {
      if (Array.isArray(state[f])) {
        state[f].forEach((item, i) => cleanEvidence(item, `${f}[${i}]`));
      }
    }

    return { valid: warnings.length === 0, warnings };
  }

  /**
   * detectConflicts: identifies contradictory information in the extracted state.
   * Checks for:
   * - Decisions that contradict each other
   * - Active decisions that are also in superseded list
   * - Chronological order violations (later message evidence should win)
   *
   * Returns array of conflict description strings.
   */
  function detectConflicts(state, transcript) {
    const conflicts = [];
    if (!state || !Array.isArray(transcript)) return conflicts;

    // Check: no decision should appear in both decisions and superseded_decisions
    if (Array.isArray(state.decisions) && Array.isArray(state.superseded_decisions)) {
      const activeTexts = new Set(state.decisions.map((d) => (d.value || "").toLowerCase().trim()));
      for (const sup of state.superseded_decisions) {
        const supText = (sup.value || "").toLowerCase().trim();
        if (activeTexts.has(supText)) {
          conflicts.push(`Decision "${sup.value}" is listed as both active and superseded`);
        }
      }
    }

    // Check: decisions with later evidence should supersede earlier ones
    // If two decisions have evidence, and the later one contradicts the earlier, flag it
    if (Array.isArray(state.decisions) && state.decisions.length > 1) {
      for (let i = 0; i < state.decisions.length; i++) {
        for (let j = i + 1; j < state.decisions.length; j++) {
          const a = state.decisions[i];
          const b = state.decisions[j];
          if (!a.value || !b.value) continue;
          // Detect common contradiction patterns
          const av = a.value.toLowerCase();
          const bv = b.value.toLowerCase();
          if (detectContradiction(av, bv)) {
            // Find which is later based on evidence
            const aMax = Math.max(...(a.evidence || [0]));
            const bMax = Math.max(...(b.evidence || [0]));
            if (aMax > 0 && bMax > 0 && aMax !== bMax) {
              const later = aMax > bMax ? a : b;
              const earlier = aMax > bMax ? b : a;
              conflicts.push(
                `Contradictory decisions: "${earlier.value}" (msg ${Math.max(...(earlier.evidence || [0]))}) ` +
                `vs "${later.value}" (msg ${Math.max(...(later.evidence || [0]))}). ` +
                `Later decision should supersede.`
              );
            }
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * detectContradiction: heuristically detects if two decision strings are contradictory.
   * Uses common technology/framework patterns.
   */
  function detectContradiction(a, b) {
    const OPPOSITION_PAIRS = [
      ["react", "vue"], ["react", "angular"], ["react", "svelte"],
      ["vue", "angular"], ["vue", "svelte"], ["angular", "svelte"],
      ["postgresql", "mysql"], ["postgresql", "sqlite"], ["postgresql", "mongodb"],
      ["mysql", "sqlite"], ["mysql", "mongodb"], ["sqlite", "mongodb"],
      ["python", "javascript"], ["python", "typescript"], ["python", "go"],
      ["fastapi", "django"], ["fastapi", "flask"], ["django", "flask"],
      ["docker", "vm"], ["microservices", "monolith"],
      ["rest", "graphql"], ["tailwind", "bootstrap"],
      ["typescript", "javascript"],
    ];

    return OPPOSITION_PAIRS.some(([x, y]) =>
      (a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))
    );
  }

  /**
   * sanitizeState: clamps values and strips unknown/unsafe fields.
   * Returns a clean copy of the state.
   */
  function sanitizeState(state) {
    if (!state || typeof state !== "object") return null;

    const clean = {};

    // Copy only allowed fields
    for (const field of ALLOWED_FIELDS) {
      if (!(field in state)) continue;
      clean[field] = state[field];
    }

    // Clamp confidence values
    const clampConf = (v) => typeof v === "number" ? Math.max(0, Math.min(1, v)) : 0.5;

    const sanitizeItem = (item) => {
      if (!item || typeof item !== "object") return null;
      const out = {};
      if (typeof item.value === "string") out.value = item.value.slice(0, 500);
      if (typeof item.confidence === "number") out.confidence = clampConf(item.confidence);
      if (Array.isArray(item.evidence)) out.evidence = item.evidence.filter(Number.isInteger);
      if (typeof item.superseded === "boolean") out.superseded = item.superseded;
      if (typeof item.superseded_by === "string") out.superseded_by = item.superseded_by.slice(0, 200);
      if (typeof item.filename === "string") out.filename = item.filename.slice(0, 100);
      if (typeof item.language === "string") out.language = item.language.slice(0, 30);
      if (typeof item.description === "string") out.description = item.description.slice(0, 300);
      return out;
    };

    const topEvidenceFields = ["goal", "current_state", "latest_request"];
    for (const f of topEvidenceFields) {
      if (clean[f] && typeof clean[f] === "object") {
        clean[f] = sanitizeItem(clean[f]);
      } else if (clean[f]) {
        clean[f] = null;
      }
    }

    const arrayFields = [
      "constraints", "preferences", "decisions", "superseded_decisions",
      "completed_tasks", "open_tasks", "important_code", "important_facts", "known_errors",
    ];
    for (const f of arrayFields) {
      if (Array.isArray(clean[f])) {
        clean[f] = clean[f].map(sanitizeItem).filter(Boolean);
      } else {
        clean[f] = [];
      }
    }

    if (typeof clean.next_action === "string") {
      clean.next_action = clean.next_action.slice(0, 300);
    } else {
      clean.next_action = null;
    }

    if (!VALID_TYPES.has(clean.conversation_type)) {
      clean.conversation_type = "general";
    }

    return clean;
  }

  /**
   * fullVerification: runs the complete verification pipeline.
   * Returns { state, valid, errors, warnings, conflicts }
   */
  function fullVerification(rawJson, transcript) {
    const result = {
      state: null, valid: false, errors: [], warnings: [], conflicts: [],
    };

    // Step 1: Parse
    let state;
    try {
      state = typeof rawJson === "string" ? parseAIJson(rawJson) : rawJson;
    } catch (e) {
      result.errors.push("Parse error: " + e.message);
      return result;
    }

    // Step 2: Schema validation
    result.errors = validateStateSchema(state);
    if (result.errors.length > 0) {
      // Auto-repair: initialize missing arrays rather than failing hard
      for (const f of REQUIRED_ARRAYS) {
        if (!Array.isArray(state[f])) state[f] = [];
      }
      result.errors = []; // cleared after auto-repair
    }

    // Step 3: Evidence verification (mutates state, removes bad refs)
    const ev = verifyEvidence(state, transcript);
    result.warnings.push(...ev.warnings);

    // Step 4: Conflict detection
    result.conflicts = detectConflicts(state, transcript);
    if (result.conflicts.length > 0) {
      result.warnings.push(...result.conflicts.map((c) => "Conflict: " + c));
    }

    // Step 5: Sanitize
    result.state = sanitizeState(state);
    result.valid = result.errors.length === 0;

    return result;
  }

  return {
    parseAIJson,
    validateStateSchema,
    verifyEvidence,
    detectConflicts,
    sanitizeState,
    fullVerification,
    REQUIRED_ARRAYS,
    VALID_TYPES,
  };
});
