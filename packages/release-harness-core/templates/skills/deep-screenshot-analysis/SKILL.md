---
name: release-harness-deep-screenshot-analysis
description: >-
  Vision-driven critique of every UAT screenshot. Reads each PNG with the
  multimodal model and scores it against a structured checklist (visual integrity,
  primary CTA visible, no clipped/overlapping text, journey-intent satisfied,
  empty-state messaging, focus rings, brand drift, contrast smell-test). Emits a
  per-screenshot scorecard plus fix-plan items for every failed check. Use when
  asked to "review the screenshots", "vision audit", "is the UI actually right",
  or as the second pass inside headed-e2e.
compatibility: Requires a multimodal model with image-input capability (Claude 3.5+, GPT-4V, Gemini 1.5+). Reads images via the host's vision tool (e.g. VS Code Copilot's view_image, Claude Code's image input).
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Deep Screenshot Analysis

Use this skill to do what a human reviewer would do: open each screenshot, look at it, and write down what's wrong. Pixel-presence is not proof of UI quality. A test can be green and the screen can still be broken (empty state with no copy, primary CTA off-screen, modal stacking incorrectly, text overlapping a background image, focus ring invisible against a dark surface).

This skill is the *only* place in the suite where the model is required to look at images. Every other skill describes what to capture; this one judges what was captured.

## When To Use

- After `headed-e2e` finishes a journey and the screenshot folder is populated.
- After `full-site-crawler` finishes a route sweep.
- After `ux-design-review` produces viewport captures.
- As a manual gate when the operator says "look at the screenshots and tell me what's broken".

## Inputs

Required:

- A directory of PNG/JPEG screenshots, each with a deterministic filename like `<journey>_step<N>_<persona>_<viewport>_<browser>.png`.
- A manifest JSON describing each screenshot's *intent*: what step it captures, what the operator should see, what the journey expected.

```json
{
  "screenshots": [
    {
      "path": "results/2026-05-24_140230/e2e/headed/screenshots/checkout_step03_buyer_1440x900_chromium.png",
      "journey_id": "journey-checkout",
      "persona_id": "persona-buyer",
      "step_index": 3,
      "action": "click",
      "target": "button#place-order",
      "expected_assertions": ["confirmation banner visible", "order id displayed", "primary CTA: 'View order' visible"],
      "viewport": "1440x900",
      "browser": "chromium",
      "url_at_capture": "/checkout/confirm",
      "is_failure_screenshot": false
    }
  ]
}
```

If the manifest is missing, this skill MUST refuse to run — judging a screenshot without knowing what it should show is guessing.

### External brand contract (REQUIRED)

This skill loads an **external brand contract** — it does NOT infer brand
identity from the screenshots or from any persona's opinion. The
contract is supplied by the operator / project context (e.g.
`docs/project/brand-contract.json`, referenced from the origin contract)
and declares, per origin, the identity that MUST and MUST NOT appear:

```json
{
  "brand": "Orvantix",
  "origins": {
    "buyer-web": {
      "required_identity": ["logo 'Orvantix' visible", "brand wordmark in header", "palette #0B5FFF primary"],
      "forbidden_identity": ["placeholder 'Lorem ipsum' logo", "prior brand 'Acme'", "system-default Times New Roman"],
      "canary": {
        "id": "brand-canary-01",
        "asset": "docs/project/brand/canary-known-good.png",
        "expected_verdict": "pass",
        "purpose": "a known-good reference frame the model MUST grade 'pass'; if it fails, vision grading is unreliable this run"
      }
    }
  }
}
```

- `required_identity` — assertions that MUST be visibly satisfied on that
  origin's screenshots. A missing required identity element is a
  `brand-identity` failure, regardless of overall aesthetic score.
- `forbidden_identity` — assertions that MUST NOT appear. A visible
  forbidden element is an automatic failure.
- `canary` — a deterministic control. The model grades the referenced
  known asset every run; its result MUST match `expected_verdict`. A
  non-matching canary means vision grading is unreliable — the run is
  marked `unproven` (see Gates), not green.

If the brand contract is absent, this skill refuses to certify brand
coherence: dimensions 10 (brand coherence) and the identity checks are
recorded as `unproven` rather than `pass`.

## The Checklist (every screenshot scored against all 12)

Each screenshot is scored 0-100 across these dimensions. Anything below the per-check threshold becomes a `fix-plan` item.

| # | Check | Pass condition | Threshold |
|---|---|---|---|
| 1 | **Visual integrity** | No torn rendering, no half-loaded images, no spinner stuck mid-screen, no white flash, no broken image icons. | 90 |
| 2 | **Layout containment** | No content overflows its container. No horizontal scrollbar on the body unless the journey expected it. No element clipped at a viewport edge except by design (sticky footer, off-screen drawer). | 90 |
| 3 | **Text legibility** | No overlapping text on text. No text overlapping non-text (icons, images, buttons). No invisible text (same color as background). All visible labels are readable at this viewport. | 95 |
| 4 | **Primary CTA visibility** | The journey's expected primary action is on-screen, fully visible, and visually dominant relative to secondary actions. If the step does not have a CTA (e.g. confirmation screen), the expected confirmation message is visible instead. | 90 |
| 5 | **Journey-intent match** | Every assertion in `expected_assertions` is visibly satisfied. If the manifest says "order id displayed", an order id MUST be visible in the screenshot. | 95 |
| 6 | **Empty-state handling** | If a list/grid/table is empty, an explicit empty-state message is shown. No silent blank rectangles. | 85 |
| 7 | **Focus ring presence** | If the screenshot was captured after a keyboard interaction (Tab, Enter), the focused element has a visible focus ring with adequate contrast against its background. | 85 |
| 8 | **Modal/overlay stacking** | If a modal/drawer/toast is present, it sits above the page content with a visible scrim/backdrop and no z-index bleed. The underlying page is not interactive. | 90 |
| 9 | **Contrast smell-test** | No obvious WCAG-violating text on background. (Coarse heuristic — the `ux-design-review` skill does the precise WCAG audit; this catches the egregious cases.) | 80 |
| 10 | **Brand coherence** | The screenshot uses the project's documented color palette and typography. No system-default styling (browser default buttons, Times New Roman) leaking through. | 80 |
| 11 | **Mobile gesture target sizing** (mobile viewports only) | Every interactive control's tap target is ≥ 44×44 px. No two interactive controls overlap. | 90 |
| 12 | **Error/loading state correctness** | If the journey expected an error or loading state, the correct visual is shown (inline validation, toast, spinner with label). No silent failures or spinners-forever. | 90 |

A screenshot's overall score = mean of the 12 dimensions. Any dimension below its threshold = automatic fix-plan item, regardless of overall score.

## Analysis Procedure

For each screenshot in the manifest:

1. **Load the image.** Use the host's image-viewing tool (e.g. `view_image` in VS Code Copilot, image input in Claude Code). Failure to open the image is a `tooling-error` fix-plan item — never silently skipped.

2. **Read the manifest entry.** Internalize `expected_assertions`, the action that produced the screenshot, and the viewport/browser context.

3. **Score the 12 dimensions.** Each dimension gets a score 0-100 and a one-sentence justification. The justification MUST cite a visible feature of the screenshot — coordinates ("top-right corner"), text ("the label 'Submit' is clipped"), or visual element ("the modal scrim is missing").

4. **Compare against journey intent.** For dimension 5, if `expected_assertions` includes "confirmation banner visible" and you cannot see a banner, that's a failure. If the assertion says "order id displayed" and you see the literal text "ORD-12345", that's a pass.

5. **Emit findings.** Every dimension below threshold becomes a fix-plan item with `category: "rendering"` or `category: "ux-regression"` and `evidence.screenshot` pointing to the file.

6. **Write the per-screenshot scorecard** under `results/<ts>/screenshot-analysis/<screenshot-basename>.json`.

## Output

- `results/<ts>/screenshot-analysis/<origin-id>/scorecards/<screenshot-basename>.json` — one file per screenshot (nested under the screenshot's `origin_id`), full 12-dimension breakdown.
- `results/<ts>/screenshot-analysis/summary.md` — human-readable summary: pass/fail/unproven counts, top 10 worst screenshots, distribution by dimension.
- `results/<ts>/screenshot-analysis/fix-plan.json` — every failed dimension, every missing/forbidden brand-identity assertion, and every `unproven` verdict as a fix-plan item.
- `results/<ts>/screenshot-analysis/coverage-by-origin.json` — per `origin_id`: `{ origin_id, screenshots_analyzed, brand_required_satisfied, brand_forbidden_clear, canary_id, canary_result, canary_expected, verdict: "pass"|"fail"|"unproven" }`. Every `browser_app` origin from the contract MUST appear.
- `results/<ts>/screenshot-analysis/coverage.json` — `{ total_screenshots, analyzed, skipped_with_reason }`. Coverage MUST be 100% — if any screenshot was not analyzed, the run is incomplete.

### Scorecard JSON shape

```json
{
  "screenshot": "results/.../checkout_step03_buyer_1440x900_chromium.png",
  "journey_id": "journey-checkout",
  "persona_id": "persona-buyer",
  "viewport": "1440x900",
  "browser": "chromium",
  "overall_score": 78,
  "verdict": "fail",
  "dimensions": {
    "visual_integrity":      { "score": 95, "verdict": "pass", "note": "No torn rendering. All images loaded." },
    "layout_containment":    { "score": 60, "verdict": "fail", "note": "The 'Place order' button is clipped at the right edge at 1440x900." },
    "text_legibility":       { "score": 100, "verdict": "pass", "note": "All labels are crisp and readable." },
    "primary_cta_visibility":{ "score": 50, "verdict": "fail", "note": "Primary CTA ('Place order') is partially off-screen; the secondary 'Cancel' button is fully visible and competes for attention." },
    "journey_intent_match":  { "score": 70, "verdict": "fail", "note": "Manifest expected 'confirmation banner visible' but no banner is rendered." },
    "empty_state_handling":  { "score": 100, "verdict": "pass", "note": "N/A — no list on this screen." },
    "focus_ring_presence":   { "score": 100, "verdict": "pass", "note": "N/A — mouse interaction." },
    "modal_overlay_stacking":{ "score": 100, "verdict": "pass", "note": "N/A — no modal present." },
    "contrast_smell_test":   { "score": 90, "verdict": "pass", "note": "No obvious contrast violations." },
    "brand_coherence":       { "score": 95, "verdict": "pass", "note": "Palette and typography consistent with the rest of the app." },
    "mobile_gesture_sizing": { "score": 100, "verdict": "pass", "note": "N/A — desktop viewport." },
    "error_loading_state":   { "score": 100, "verdict": "pass", "note": "N/A — no error/loading state expected." }
  },
  "fix_plan_items": ["ssa-001", "ssa-002", "ssa-003"]
}
```

### Fix-plan item examples

```json
{
  "id": "ssa-002",
  "severity": "high",
  "category": "ux-regression",
  "title": "Primary CTA clipped at 1440x900 on checkout confirmation",
  "description": "The 'Place order' button is partially off-screen at desktop viewport 1440x900 in chromium. Visible in checkout_step03_buyer_1440x900_chromium.png. The secondary 'Cancel' button is fully visible and visually competes with the primary action.",
  "affected_files": ["src/components/Checkout/PlaceOrderButton.tsx", "src/pages/Checkout/Confirm.tsx"],
  "suggested_fix": "Constrain the action bar to a max-width and right-align with viewport-safe padding. Verify all viewports in the matrix.",
  "effort": "small",
  "dependencies": [],
  "evidence": {
    "screenshot": "results/2026-05-24_140230/e2e/headed/screenshots/checkout_step03_buyer_1440x900_chromium.png",
    "dimension": "primary_cta_visibility",
    "dimension_score": 50,
    "expected_assertion": "primary CTA: 'View order' visible"
  },
  "related_items": [],
  "sources": ["release-harness-deep-screenshot-analysis"]
}
```

## Hard Rules

- **Look at every screenshot.** Coverage MUST be 100%. A screenshot that cannot be opened is a `tooling-error` fix-plan item, not a silent skip.
- **Cite visible evidence.** Every dimension justification MUST refer to something concretely visible in the image — a label, a position, a color. "Looks fine" is not a justification.
- **Compare against intent, not aesthetics alone.** A screenshot can be beautiful and still fail dimension 5 (journey-intent match) if the expected element is absent.
- **Per-dimension thresholds are non-negotiable.** Do not raise thresholds to make a screenshot pass.
- **No fabricated findings.** Every fix-plan item MUST reference a real screenshot path that exists on disk.
- **Failures are not retried.** If a screenshot scores poorly, that's the verdict for this run. The fix lives in `fix-plan.json`, not in re-running this skill with different prompts.

## Performance Considerations

Vision analysis is slow (1-5 s per screenshot depending on model and image size). For runs with hundreds of screenshots:

- Process serially. Parallel image input often degrades model accuracy.
- Stream output to `summary.md` as each screenshot completes so progress is visible.
- If the manifest exceeds 200 screenshots, ASK the operator whether to:
  - analyze all (recommended for release gates),
  - analyze failures + sampled 20% of passes (cheap mode),
  - analyze only failures (fastest, but misses "green test, broken UI" cases).

The orchestrator (`uat-runner` agent) controls the mode; this skill obeys.

## Failure Modes To Surface

- **Manifest missing fields.** If `expected_assertions` is empty for a step, this skill cannot score dimension 5. Emit a `manifest-gap` fix-plan item for the journey-mapping skill to fix.
- **Image unreadable.** Corrupted PNG, missing file, wrong format. Emit a `tooling-error` fix-plan item and continue.
- **All screenshots passing / near-zero-interaction evidence is UNPROVEN, not green.** Suspiciously clean evidence — every screenshot passing all 12 dimensions, OR a manifest whose screenshots show near-zero interaction (no error state ever captured, no empty state, no focus sweep, no populated data, all frames on the same URL) — does NOT certify the UI. Mark the affected origin `verdict: "unproven"` in `coverage-by-origin.json`, add a `suspicious-evidence` fix-plan item, and require real interaction/state evidence before it can be graded green. Treat an all-pass with a failing/absent canary as `unproven` for the whole run.
- **Synthetic and persona judgment is non-authoritative.** Assertions synthesized by `full-site-crawler` (page-metadata-derived) and any persona's stated preference are inputs, not authority. Brand identity is decided ONLY by the external brand contract; a screenshot cannot pass brand-identity checks because a synthetic assertion or persona "liked it".

## Pipeline Contract

Standard pipeline contract applies — working directory, `./.quality-run/` layout (artefacts vs results), worktree-only rules, and gate semantics per `references/pipeline-contract.md` (vendored into this skill's install). This skill's specifics:

### Required input

- A manifest JSON listing the screenshots to analyze, with `expected_assertions` and an `origin_id` per screenshot. Produced by `headed-e2e`, `full-site-crawler`, or `ux-design-review`.
- The screenshot files themselves at the paths the manifest references.
- An external **brand contract** (e.g. `docs/project/brand-contract.json`) declaring per-origin `required_identity`, `forbidden_identity`, and a deterministic `canary`. Without it, brand-identity checks are recorded `unproven`, not `pass`.

### Outputs this skill produces

- **Artefacts:** none.
- **Results:** `results/<ts>/screenshot-analysis/<origin-id>/scorecards/*.json`, `results/<ts>/screenshot-analysis/summary.md`, `results/<ts>/screenshot-analysis/fix-plan.json`, `results/<ts>/screenshot-analysis/coverage-by-origin.json`, `results/<ts>/screenshot-analysis/coverage.json`.

### Hard rules

- 100% screenshot coverage. Any skip MUST appear in `coverage.json` with a reason.
- Every fix-plan item MUST have `evidence.screenshot`, `evidence.dimension`, and `evidence.dimension_score`.
- No analysis without a manifest. Refuse to run if the input manifest is absent or empty.
- Brand identity is judged ONLY against the external brand contract's `required_identity` / `forbidden_identity`; synthetic (crawler) and persona judgments are non-authoritative. Missing brand contract ⇒ brand checks are `unproven`, not `pass`.
- Grade the deterministic `canary` every run; if its result does not match `expected_verdict`, mark the origin/run `unproven`.
- Suspicious all-pass or near-zero-interaction evidence is `unproven`, never green.
- Per `browser_app` origin, the analyzed manifest MUST include the applicable state evidence (empty, populated, error, loading, offline) and an accessibility (focus-ring/landmark) frame. If a state is absent from the manifest, record it as an evidence gap for that origin in `coverage-by-origin.json` and treat the origin's state coverage as `unproven`, not `pass`.

### Gates

- Mark an origin/run `unproven` (do NOT report green) when the brand-contract canary result disagrees with its `expected_verdict`, or when evidence is suspiciously all-pass / near-zero-interaction. Emit a `suspicious-evidence` / `canary-mismatch` fix-plan item.
- Fail the run for any origin whose screenshots show a `forbidden_identity` element or omit a `required_identity` element from the brand contract.
- Stop and warn if more than 30% of analyzed screenshots fail dimension 5 (journey-intent match). That indicates the journey itself is misaligned with reality, not a UI regression. Hand back to `journey-mapping`.
- Stop and warn if dimension 1 (visual integrity) fails on more than 10% of screenshots. That indicates the UAT environment is unstable (resource starvation, missing assets) and analysis is unreliable.
